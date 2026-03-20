# my-airdrop

Share files over your local network — like AirDrop, but from your terminal.

```
npx my-airdrop
```

Opens a web interface on your local network. Anyone on the same WiFi can upload and download files by scanning a QR code — no app, no account, no cable needed.

## Preview

```
  ◆ my-airdrop

  Serving  ~/Desktop/projects

  Local    http://localhost:3000
  Network  http://192.168.1.5:3000

  [QR CODE]

  Scan QR or open the Network URL on any device
  Ctrl+C to stop

  ────────────────────────────────────────────────

  17:22:12  ↓  192.168.1.10     README.md (2.1 KB)
  17:22:45  ↑  192.168.1.10     photo.jpg (3.4 MB)
```

## Features

- **Download** — browse and download files from any device on the network
- **Upload** — send files from your phone to your computer (tap or drag & drop)
- **Folder download** — zip and download entire folders in one tap
- **Multi-select** — select multiple files and download as a zip
- **QR code** — instantly connect with your phone camera
- **Mobile-optimized** — large touch targets, responsive layout, dark UI
- **Safety limits** — warns on large directories, hard limit at 5000 files / 5 GB

## Usage

```bash
# Serve current directory
npx my-airdrop

# Serve a specific folder
npx my-airdrop ./photos

# Custom port
npx my-airdrop --port 8080

# Read-only (disable uploads)
npx my-airdrop --no-upload
```

## Install globally

```bash
npm install -g my-airdrop
my-airdrop
```

## Requirements

- Node.js >= 14
- Both devices on the same WiFi network

## License

MIT
