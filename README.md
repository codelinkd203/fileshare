# FileShare

> Instant wireless file transfer — transfer files instantly between any devices on any network.

![FileShare UI](public/screenshot.png)

## Features

- **Instant file transfers** — drag-and-drop files to nearby or manually-added devices
- **Folder transfers** — auto-zips and sends entire folders
- **Share Links** — create temporary download URLs for files on your local network with optional expiry
- **QR Codes** — scan to add devices or access share links
- **System Notifications** — get notified when files arrive, click to open FileShare
- **Transfer History** — full log of sent/received transfers with open/reveal actions
- **Customizable UI** — dark/light/midnight themes, 6 accent color presets
- **Tray Integration** — lives in your system tray, runs in background
- **No cloud required** — fully peer-to-peer over your network

## Tech Stack

- **Electron** — cross-platform desktop shell
- **Express + Socket.IO** — embedded local HTTP/WebSocket server
- **Multer** — file upload handling
- **Archiver** — folder compression
- **QRCode** — QR generation

## Getting Started

```bash
# Install dependencies
npm install

# Run in development
npm run dev

# Run normally
npm start
```

## How It Works

1. FileShare starts an embedded Express server on port **3847**
2. Other FileShare instances (or browsers) can send files via `POST /upload`
3. You can manually add a device by IP address
4. Files are saved to `~/FileShare/received/`
5. Shared links serve from `~/FileShare/shared/`

## Sending Files from Browser / CLI

You can send files to any FileShare instance without the app:

```bash
# Using curl
curl -X POST http://DEVICE_IP:3847/upload \
  -H "x-sender-name: My Phone" \
  -F "files=@/path/to/file.pdf"
```

## Architecture

```
src/
├── main/
│   ├── main.js       # Electron main process, Express server, IPC handlers
│   └── preload.js    # Secure context bridge
└── renderer/
    ├── index.html    # App shell
    ├── app.js        # UI logic
    └── styles/
        └── main.css  # Vercel-style design system
```

## Customization

- **Themes**: Dark (default), Light, Midnight
- **Accent Colors**: White, Blue, Green, Amber, Red, Purple
- **Device Name**: Set a custom name shown to other devices
- **Save Location**: Choose where received files are stored

## Network Requirements

FileShare devices must be on the same network, or you can use it over the internet by forwarding port 3847.
