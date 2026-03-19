const { app, BrowserWindow, ipcMain, Notification, dialog, shell, Tray, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const fse = require('fs-extra');
const QRCode = require('qrcode');

let mainWindow;
let tray;
let io, expressApp, httpServer;
let udpDiscovery = null;  // pure UDP multicast, no third-party deps

const PORT = 3847;
const DEVICE_ID = uuidv4();
let DEVICE_NAME = os.hostname().replace('.local', '');

const UPLOAD_DIR = path.join(os.homedir(), 'FileShare', 'received');
const SHARE_DIR  = path.join(os.homedir(), 'FileShare', 'shared');
fse.ensureDirSync(UPLOAD_DIR);
fse.ensureDirSync(SHARE_DIR);

const peers = new Map();
const transferHistory = [];
const sharedFiles = new Map();
let totalBytesSent = 0;
let totalBytesReceived = 0;

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function notifyWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function formatBytes(b) {
  if (!b || b === 0) return '0 B';
  const u = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(Math.max(b,1)) / Math.log(1024));
  return `${(b / 1024 ** i).toFixed(1)} ${u[i]}`;
}

// ─── UDP Multicast Discovery ─────────────────────────────
// Pure Node.js built-ins only — zero npm packages, zero third-party dependencies.
// Uses UDP multicast on 239.255.255.250:3848 (standard LAN multicast address).
// Every instance broadcasts ANNOUNCE every 5s and replies to DISCOVER pings.
// On quit, sends BYE so peers are removed instantly on other devices.

const DISCOVERY_ADDR = '239.255.255.250';
const DISCOVERY_PORT = 3848;
let udpSocket    = null;
let announceTimer = null;

function buildPacket(type) {
  return JSON.stringify({
    type, id: DEVICE_ID, name: DEVICE_NAME,
    port: PORT, platform: process.platform, v: '1'
  });
}

function setupUDPDiscovery() {
  const dgram = require('dgram');
  const sock  = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpSocket   = sock;

  sock.on('error', err => console.warn('[Discovery]', err.message));

  sock.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg.id || msg.id === DEVICE_ID) return;

    if (msg.type === 'ANNOUNCE' || msg.type === 'REPLY') {
      const isNew = !peers.has(msg.id);
      const peer  = {
        id: msg.id, name: msg.name, ip: rinfo.address,
        port: msg.port || PORT, platform: msg.platform || 'unknown',
        lastSeen: Date.now(), discovery: 'auto'
      };
      peers.set(peer.id, peer);
      notifyWindow('peers-updated', Array.from(peers.values()));
      if (isNew) notifyWindow('peer-discovered', peer);

    } else if (msg.type === 'DISCOVER') {
      // Someone scanning — unicast reply directly back to them
      const reply = Buffer.from(buildPacket('REPLY'));
      sock.send(reply, 0, reply.length, rinfo.port, rinfo.address);

    } else if (msg.type === 'BYE') {
      peers.delete(msg.id);
      notifyWindow('peers-updated', Array.from(peers.values()));
    }
  });

  sock.bind(DISCOVERY_PORT, () => {
    try {
      sock.addMembership(DISCOVERY_ADDR);
      sock.setMulticastTTL(4);
      sock.setMulticastLoopback(false);
    } catch (e) {
      // Fallback: plain UDP broadcast if multicast is blocked
      console.warn('[Discovery] multicast unavailable, using broadcast');
      try { sock.setBroadcast(true); } catch {}
    }

    const multicast = (type) => {
      const pkt = Buffer.from(buildPacket(type));
      sock.send(pkt, 0, pkt.length, DISCOVERY_PORT, DISCOVERY_ADDR);
    };

    // Announce self immediately, then every 5s
    multicast('ANNOUNCE');
    announceTimer = setInterval(() => multicast('ANNOUNCE'), 5000);

    // Probe for anyone already up
    setTimeout(() => multicast('DISCOVER'), 400);

    console.log('[Discovery] UDP multicast active on', DISCOVERY_ADDR + ':' + DISCOVERY_PORT);
  });
}

function shutdownUDPDiscovery() {
  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  if (!udpSocket) return;
  try {
    const bye = Buffer.from(buildPacket('BYE'));
    udpSocket.send(bye, 0, bye.length, DISCOVERY_PORT, DISCOVERY_ADDR, () => {
      try { udpSocket.close(); } catch {}
      udpSocket = null;
    });
  } catch { try { udpSocket.close(); } catch {}; udpSocket = null; }
}


// ─── Subnet Scan (fallback / manual) ──────────────────────
// Sweeps the local /24 for any FileShare instance — useful on networks
// where UDP multicast is blocked (some corporate/school WiFi routers).
async function subnetScan() {
  const fetch = require('node-fetch');
  const localIP = getLocalIP();
  const base    = localIP.split('.').slice(0, 3).join('.');
  const found   = [];

  const check = async (i) => {
    const ip = base + '.' + i;
    if (ip === localIP) return;
    try {
      const res  = await fetch('http://' + ip + ':' + PORT + '/info', { signal: AbortSignal.timeout(500) });
      const info = await res.json();
      if (info.id && info.id !== DEVICE_ID) {
        const isNew = !peers.has(info.id);
        const peer  = { ...info, ip, port: PORT, lastSeen: Date.now(), discovery: 'scan' };
        peers.set(peer.id, peer);
        notifyWindow('peers-updated', Array.from(peers.values()));
        if (isNew) notifyWindow('peer-discovered', peer);
        found.push(peer);
      }
    } catch {}
  };

  // Parallel batches of 32
  for (let i = 1; i <= 254; i += 32) {
    await Promise.all(
      Array.from({ length: Math.min(32, 255 - i) }, (_, j) => check(i + j))
    );
  }
  return found;
}

// ─── Express Server ────────────────────────────────────────
function setupServer() {
  expressApp = express();
  httpServer = http.createServer(expressApp);
  io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(decoded);
      const base = path.basename(decoded, ext);
      cb(null, `${base}_${Date.now()}${ext}`);
    }
  });
  const upload = multer({ storage });

  expressApp.use(express.json());
  expressApp.use('/files', express.static(SHARE_DIR));

  expressApp.get('/info', (req, res) => {
    res.json({ id: DEVICE_ID, name: DEVICE_NAME, platform: process.platform, version: app.getVersion() });
  });

  expressApp.post('/upload', upload.array('files'), (req, res) => {
    const senderName = req.headers['x-sender-name'] || 'Unknown Device';
    const senderId   = req.headers['x-sender-id']   || 'unknown';
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files' });

    const totalSize = files.reduce((s, f) => s + f.size, 0);
    totalBytesReceived += totalSize;

    const transfer = {
      id: uuidv4(), type: 'received', sender: senderName, senderId,
      files: files.map(f => ({ name: f.originalname, size: f.size, path: f.path })),
      timestamp: Date.now(), status: 'completed', size: totalSize
    };
    transferHistory.unshift(transfer);
    if (transferHistory.length > 200) transferHistory.pop();

    notifyWindow('transfer-received', transfer);

    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'FileShare — Files Received',
        body: `${files.length} file${files.length > 1 ? 's' : ''} from ${senderName} · ${formatBytes(totalSize)}`
      });
      n.on('click', () => { mainWindow?.show(); mainWindow?.focus(); notifyWindow('navigate', 'receive'); });
      n.show();
    }
    res.json({ success: true, transferId: transfer.id });
  });

  expressApp.post('/share', (req, res) => {
    const { filePath, ttl } = req.body;
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const shareId  = uuidv4().slice(0, 8);
    const fileName = path.basename(filePath);
    const destPath = path.join(SHARE_DIR, `${shareId}_${fileName}`);
    fse.copySync(filePath, destPath);
    const shareInfo = {
      id: shareId, originalName: fileName, path: destPath,
      url: `http://${getLocalIP()}:${PORT}/files/${shareId}_${encodeURIComponent(fileName)}`,
      created: Date.now(), expires: ttl ? Date.now() + ttl * 60000 : null, downloads: 0
    };
    sharedFiles.set(shareId, shareInfo);
    res.json(shareInfo);
  });

  expressApp.get('/shared', (req, res) => {
    res.json(Array.from(sharedFiles.values()).filter(f => !f.expires || f.expires > Date.now()));
  });

  expressApp.get('/stats', (req, res) => {
    res.json({ sent: totalBytesSent, received: totalBytesReceived, transfers: transferHistory.length });
  });

  io.on('connection', (socket) => {
    socket.on('peer-announce', (data) => {
      peers.set(data.id, { ...data, socketId: socket.id, lastSeen: Date.now() });
      notifyWindow('peers-updated', Array.from(peers.values()));
    });
    socket.on('disconnect', () => {
      for (const [id, p] of peers.entries()) {
        if (p.socketId === socket.id) { peers.delete(id); break; }
      }
      notifyWindow('peers-updated', Array.from(peers.values()));
    });
    socket.on('transfer-progress', (data) => notifyWindow('transfer-progress', data));
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`FileShare server on port ${PORT}`);
    notifyWindow('server-ready', { ip: getLocalIP(), port: PORT });
    setupUDPDiscovery();
    setTimeout(() => subnetScan(), 2500);
  });
}

// ─── Window ────────────────────────────────────────────────
function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1120, height: 760, minWidth: 820, minHeight: 580,
    // On macOS: hiddenInset keeps NATIVE traffic lights (no custom buttons shown in HTML).
    // On Windows/Linux: fully frameless, custom buttons drawn in HTML.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
    frame: false,
    backgroundColor: '#0a0a0a',
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function setupTray() {
  try {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png'));
    tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
    tray.setToolTip('FileShare');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open FileShare', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: DEVICE_NAME, enabled: false },
      { label: `${getLocalIP()}:${PORT}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Received Folder', click: () => shell.openPath(UPLOAD_DIR) },
      { label: 'Scan for Devices',     click: () => subnetScan() },
      { type: 'separator' },
      { label: 'Quit FileShare', click: () => app.quit() }
    ]));
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch (e) { console.warn('Tray:', e.message); }
}

// ─── IPC ──────────────────────────────────────────────────
ipcMain.handle('get-device-info', () => ({
  id: DEVICE_ID, name: DEVICE_NAME, ip: getLocalIP(), port: PORT,
  platform: process.platform, isMac: process.platform === 'darwin'
}));

ipcMain.handle('get-peers', () => Array.from(peers.values()));
ipcMain.handle('get-transfer-history', () => transferHistory);
ipcMain.handle('get-shared-files', () => Array.from(sharedFiles.values()));
ipcMain.handle('get-stats', () => ({
  sent: totalBytesSent, received: totalBytesReceived,
  transfers: transferHistory.length, peers: peers.size
}));

ipcMain.handle('scan-network', async () => {
  notifyWindow('scan-started', {});
  const found = await subnetScan();
  notifyWindow('scan-complete', { found: found.length });
  return found;
});

ipcMain.handle('select-files', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('send-files', async (event, { targetIP, targetPort, filePaths, senderName }) => {
  const FormData = require('form-data');
  const fetch = require('node-fetch');
  const form = new FormData();
  let totalSize = 0;

  for (const fp of filePaths) {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      const zipPath = path.join(os.tmpdir(), `${path.basename(fp)}_${Date.now()}.zip`);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip', { zlib: { level: 6 } });
        out.on('close', resolve); arc.on('error', reject);
        arc.pipe(out); arc.directory(fp, path.basename(fp)); arc.finalize();
      });
      totalSize += fs.statSync(zipPath).size;
      form.append('files', fs.createReadStream(zipPath), path.basename(fp) + '.zip');
    } else {
      totalSize += stat.size;
      form.append('files', fs.createReadStream(fp), path.basename(fp));
    }
  }

  const transfer = {
    id: uuidv4(), type: 'sent',
    recipient: targetIP, recipientName: senderName,
    files: filePaths.map(p => ({ name: path.basename(p), path: p })),
    timestamp: Date.now(), status: 'sending', size: totalSize
  };
  transferHistory.unshift(transfer);

  try {
    const res = await fetch(`http://${targetIP}:${targetPort || PORT}/upload`, {
      method: 'POST',
      headers: { 'x-sender-name': DEVICE_NAME, 'x-sender-id': DEVICE_ID, ...form.getHeaders() },
      body: form
    });
    const data = await res.json();
    transfer.status = 'completed';
    totalBytesSent += totalSize;
    notifyWindow('transfer-sent', transfer);
    return { success: true, ...data };
  } catch (err) {
    transfer.status = 'failed';
    notifyWindow('transfer-sent', transfer);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('share-file', async (_, { filePath, ttl }) => {
  try {
    const shareId  = uuidv4().slice(0, 8);
    const fileName = path.basename(filePath);
    const destPath = path.join(SHARE_DIR, `${shareId}_${fileName}`);
    fse.copySync(filePath, destPath);
    const info = {
      id: shareId, originalName: fileName, path: destPath,
      url: `http://${getLocalIP()}:${PORT}/files/${shareId}_${encodeURIComponent(fileName)}`,
      created: Date.now(), expires: ttl ? Date.now() + ttl * 60000 : null, downloads: 0
    };
    sharedFiles.set(shareId, info);
    return info;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('generate-qr', async (_, { url }) =>
  QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: '#000', light: '#fff' } })
);

ipcMain.handle('open-received-folder', () => shell.openPath(UPLOAD_DIR));
ipcMain.handle('open-file',            (_, p) => shell.openPath(p));
ipcMain.handle('reveal-file',          (_, p) => shell.showItemInFolder(p));
ipcMain.handle('copy-to-clipboard',    (_, t) => { clipboard.writeText(t); return true; });
ipcMain.handle('get-clipboard-text',   ()    => clipboard.readText());

ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.handle('window-close',    () => mainWindow?.hide());

ipcMain.handle('add-manual-peer', async (_, { ip, port }) => {
  const fetch = require('node-fetch');
  try {
    const res = await fetch(`http://${ip}:${port || PORT}/info`, { signal: AbortSignal.timeout(3000) });
    const info = await res.json();
    if (!info.id) throw new Error('Bad response');
    const peer = { ...info, ip, port: port || PORT, lastSeen: Date.now(), discovery: 'manual' };
    peers.set(info.id, peer);
    notifyWindow('peers-updated', Array.from(peers.values()));
    return { success: true, peer };
  } catch {
    return { success: false, error: 'Could not connect — is FileShare running on that device?' };
  }
});

ipcMain.handle('remove-peer', (_, { peerId }) => {
  peers.delete(peerId); notifyWindow('peers-updated', Array.from(peers.values()));
  return { success: true };
});

ipcMain.handle('remove-shared-file', (_, { shareId }) => {
  const f = sharedFiles.get(shareId);
  if (f) { fse.removeSync(f.path); sharedFiles.delete(shareId); }
  return { success: true };
});

ipcMain.handle('get-settings', () => {
  const p = path.join(app.getPath('userData'), 'settings.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { deviceName: DEVICE_NAME, theme: 'dark', accentColor: '#ffffff', notifications: true, saveDir: UPLOAD_DIR }; }
});

ipcMain.handle('save-settings', (_, settings) => {
  if (settings.deviceName) DEVICE_NAME = settings.deviceName;
  fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2));
  return { success: true };
});

// ─── App lifecycle ─────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  setupServer();
  setupTray();
  app.on('activate', () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  shutdownUDPDiscovery();
  httpServer?.close();
});
