#!/usr/bin/env node
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const https = require('https');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const localtunnel = require('localtunnel');
const { createServer } = require('../src/server');

// ── Parse args ───────────────────────────────────────
const args = process.argv.slice(2);
let servePath   = process.cwd();
let port        = 3000;
let allowUpload = true;
let usePublic   = false;

for (let i = 0; i < args.length; i++) {
  if      (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i]) || 3000;
  else if (args[i] === '--no-upload')                allowUpload = false;
  else if (args[i] === '--public')                   usePublic = true;
  else if (!args[i].startsWith('-'))                 servePath = path.resolve(args[i]);
}

if (!fs.existsSync(servePath) || !fs.statSync(servePath).isDirectory()) {
  console.error(chalk.red('  Not a directory: ' + servePath));
  process.exit(1);
}

// ── Safety scan ──────────────────────────────────────
function quickScan(dir, depth = 0) {
  let count = 0, size = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) {
        const s = quickScan(full, depth + 1);
        count += s.count; size += s.size;
      } else if (e.isFile()) {
        count++;
        try { size += fs.statSync(full).size; } catch {}
      }
    }
  } catch {}
  return { count, size };
}

function fmtBytes(b) {
  if (b < 1e6)  return (b / 1e3).toFixed(1) + ' KB';
  if (b < 1e9)  return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1e9).toFixed(1) + ' GB';
}

function fmtBytes2(b) {
  if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
}

function shortenPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const net of ifaces) {
      if (net.family === 'IPv4' && !net.internal &&
          (net.address.startsWith('192.168.') || net.address.startsWith('10.'))) {
        return net.address;
      }
    }
  }
  // fallback: any non-internal IPv4
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const net of ifaces) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ── Main ─────────────────────────────────────────────
async function main() {
  const { count, size } = quickScan(servePath);

  // Hard limit
  if (count > 5000 || size > 5e9) {
    console.log('');
    console.log('  ' + chalk.red('✖  Directory is too large to serve safely'));
    console.log(chalk.gray(`     ${count.toLocaleString()} files  ·  ${fmtBytes(size)}`));
    console.log(chalk.gray('     Try specifying a subdirectory: ') + chalk.white('my-airdrop ./subfolder'));
    console.log('');
    process.exit(1);
  }

  // Soft warning
  if (count > 300 || size > 200e6) {
    console.log('');
    console.log('  ' + chalk.yellow('⚠  Large directory'));
    console.log(chalk.gray(`     ${count.toLocaleString()} files  ·  ${fmtBytes(size)}`));
    console.log('');

    if (process.stdin.isTTY) {
      process.stdout.write(chalk.gray('  Press Enter to continue, Ctrl+C to cancel: '));
      await new Promise(resolve => {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', key => {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          if (key[0] === 3) { console.log(); process.exit(0); } // Ctrl+C
          console.log('');
          resolve();
        });
      });
    }
  }

  const localIP    = getLocalIP();
  const networkURL = `http://${localIP}:${port}`;
  const localURL   = `http://localhost:${port}`;

  const { server, events } = createServer(servePath, { allowUpload });

  events.on('log', ({ method, filePath, ip, size: sz }) => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    let arrow, label;
    if (method === 'UPLOAD') {
      arrow = chalk.hex('#818cf8')('↑');
      label = chalk.hex('#818cf8')(filePath);
    } else if (method === 'BROWSE') {
      arrow = chalk.gray('→');
      label = chalk.gray(filePath);
    } else {
      arrow = chalk.green('↓');
      label = chalk.white(filePath);
    }
    const sizeStr = sz ? chalk.gray(` (${fmtBytes2(sz)})`) : '';
    console.log(`  ${chalk.gray(time)}  ${arrow}  ${chalk.gray(ip.padEnd(15))}  ${label}${sizeStr}`);
  });

  server.listen(port, '0.0.0.0', async () => {
    console.clear();
    console.log('');
    console.log('  ' + chalk.bold.hex('#818cf8')('◆ ') + chalk.bold.white('my-airdrop'));
    console.log('');
    console.log('  ' + chalk.gray('Serving  ') + chalk.cyan(shortenPath(servePath)));
    console.log('');
    console.log('  ' + chalk.gray('Local    ') + chalk.white(localURL));
    console.log('  ' + chalk.gray('Network  ') + chalk.bold.white(networkURL));

    // Public tunnel
    let publicURL = null;
    if (usePublic) {
      process.stdout.write('  ' + chalk.gray('Public   ') + chalk.gray('connecting...'));
      try {
        const tunnel = await localtunnel({ port });
        publicURL = tunnel.url;
        process.stdout.write('\r  ' + chalk.gray('Public   ') + chalk.bold.cyan(publicURL) + '\n');

        // Fetch tunnel password (public IP)
        https.get('https://loca.lt/mytunnelpassword', res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            const pw = data.trim();
            if (pw) console.log('  ' + chalk.gray('Password ') + chalk.bold.yellow(pw) + chalk.gray('  (share this with visitors)'));
          });
        }).on('error', () => {});

        tunnel.on('close', () => {
          console.log('\n' + chalk.yellow('  ⚠  Public tunnel closed'));
        });
      } catch {
        process.stdout.write('\r  ' + chalk.yellow('Public   tunnel failed (no internet?)') + '\n');
      }
    }

    console.log('');
    const qrURL = publicURL || networkURL;
    qrcode.generate(qrURL, { small: true }, qr => {
      qr.split('\n').forEach(line => console.log('  ' + line));
    });

    console.log('');
    if (publicURL) {
      console.log(chalk.gray('  QR → public URL (works outside local network)'));
    } else {
      console.log(chalk.gray('  Scan QR or open the Network URL on any device'));
      console.log(chalk.gray('  Use ') + chalk.white('--public') + chalk.gray(' to share outside local network'));
    }
    if (!allowUpload) console.log(chalk.gray('  ⊘  Upload disabled (read-only)'));
    console.log(chalk.gray('  Ctrl+C to stop'));
    console.log('');
    console.log(chalk.gray('  ' + '─'.repeat(48)));
    console.log('');
  });

  process.on('SIGINT', () => {
    console.log('\n' + chalk.gray('  Stopped.'));
    process.exit(0);
  });
}

main().catch(e => {
  console.error(chalk.red('  Error: ' + e.message));
  process.exit(1);
});
