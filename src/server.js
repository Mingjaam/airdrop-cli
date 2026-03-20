'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const archiver = require('archiver');
const busboy = require('busboy');

const HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

const MIME = {
  html:'text/html;charset=utf-8', txt:'text/plain', md:'text/plain',
  json:'application/json', js:'application/javascript', css:'text/css',
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
  gif:'image/gif', webp:'image/webp', svg:'image/svg+xml',
  ico:'image/x-icon', mp4:'video/mp4', mov:'video/quicktime',
  mp3:'audio/mpeg', wav:'audio/wav', pdf:'application/pdf',
  zip:'application/zip',
};

function mime(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// Resolve and validate that a path stays within root
function safePath(root, reqPath) {
  const rel = decodeURIComponent(reqPath || '/').replace(/\0/g, '');
  const full = path.resolve(path.join(root, rel));
  if (full !== root && !full.startsWith(root + path.sep)) throw Object.assign(new Error('forbidden'), { status: 403 });
  return full;
}

function qs(url) {
  const i = url.indexOf('?');
  return i === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    try {
      const full = path.join(dir, e.name);
      const stat = fs.statSync(full);
      items.push({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isDirectory() ? null : stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch {}
  }
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function createServer(root, opts = {}) {
  const { allowUpload = true, maxUploadMB = 500 } = opts;
  const events = new EventEmitter();

  const server = http.createServer((req, res) => {
    const url  = req.url || '/';
    const route = url.split('?')[0];
    const q    = qs(url);
    const ip   = (req.socket.remoteAddress || '').replace('::ffff:', '');

    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      // ── HTML shell ───────────────────────────────────
      if (route === '/' || route === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
        return res.end(HTML);
      }

      // ── List directory ───────────────────────────────
      if (route === '/api/ls') {
        const dir = safePath(root, q.p);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
          return json(res, 404, { error: 'not found' });
        events.emit('log', { method: 'BROWSE', filePath: q.p || '/', ip });
        return json(res, 200, { items: scanDir(dir) });
      }

      // ── Download file ────────────────────────────────
      if (route === '/api/dl') {
        const fp = safePath(root, q.p);
        if (!fs.existsSync(fp) || !fs.statSync(fp).isFile())
          return json(res, 404, { error: 'not found' });
        const stat = fs.statSync(fp);
        const name = path.basename(fp);
        events.emit('log', { method: 'DOWNLOAD', filePath: q.p, ip, size: stat.size });
        res.writeHead(200, {
          'Content-Type': mime(name),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': stat.size,
        });
        return fs.createReadStream(fp).pipe(res);
      }

      // ── Zip a directory or file ───────────────────────
      if (route === '/api/zip') {
        const fp = safePath(root, q.p);
        if (!fs.existsSync(fp)) return json(res, 404, { error: 'not found' });
        const name = path.basename(fp) || 'files';
        events.emit('log', { method: 'DOWNLOAD', filePath: `${q.p} (zip)`, ip });
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${name}.zip"`,
        });
        const arc = archiver('zip', { zlib: { level: 6 } });
        arc.on('error', () => {});
        arc.pipe(res);
        fs.statSync(fp).isDirectory() ? arc.directory(fp, false) : arc.file(fp, { name });
        arc.finalize();
        return;
      }

      // ── Zip selected paths ───────────────────────────
      if (route === '/api/zip-selected' && req.method === 'POST') {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
          try {
            const { paths } = JSON.parse(raw);
            if (!Array.isArray(paths) || !paths.length) return json(res, 400, { error: 'no paths' });
            events.emit('log', { method: 'DOWNLOAD', filePath: `${paths.length} selected (zip)`, ip });
            res.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Disposition': 'attachment; filename="selected.zip"',
            });
            const arc = archiver('zip', { zlib: { level: 6 } });
            arc.on('error', () => {});
            arc.pipe(res);
            for (const p of paths) {
              try {
                const fp = safePath(root, p);
                const stat = fs.statSync(fp);
                stat.isDirectory()
                  ? arc.directory(fp, path.basename(fp))
                  : arc.file(fp, { name: path.basename(fp) });
              } catch {}
            }
            arc.finalize();
          } catch { json(res, 400, { error: 'bad request' }); }
        });
        return;
      }

      // ── Upload ───────────────────────────────────────
      if (route === '/api/ul' && req.method === 'POST') {
        if (!allowUpload) return json(res, 403, { error: 'upload disabled' });
        const uploadDir = safePath(root, q.p || '/');
        if (!fs.existsSync(uploadDir) || !fs.statSync(uploadDir).isDirectory())
          return json(res, 404, { error: 'directory not found' });

        const bb = busboy({ headers: req.headers, limits: { fileSize: maxUploadMB * 1024 * 1024 } });
        const saves = [];

        bb.on('file', (_name, stream, info) => {
          const filename = path.basename(info.filename || 'upload');
          const dest = path.join(uploadDir, filename);
          const ws = fs.createWriteStream(dest);
          stream.pipe(ws);
          saves.push(new Promise((resolve, reject) => {
            ws.on('finish', () => {
              const size = fs.statSync(dest).size;
              events.emit('log', { method: 'UPLOAD', filePath: filename, ip, size });
              resolve();
            });
            ws.on('error', reject);
          }));
        });

        bb.on('finish', async () => {
          try { await Promise.all(saves); json(res, 200, { ok: true }); }
          catch { json(res, 500, { error: 'save failed' }); }
        });

        bb.on('error', () => json(res, 500, { error: 'upload failed' }));
        req.pipe(bb);
        return;
      }

      json(res, 404, { error: 'not found' });

    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });

  return { server, events };
}

module.exports = { createServer };
