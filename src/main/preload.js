const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Device
  getDeviceInfo:    ()     => ipcRenderer.invoke('get-device-info'),
  getPeers:         ()     => ipcRenderer.invoke('get-peers'),
  addManualPeer:    (d)    => ipcRenderer.invoke('add-manual-peer', d),
  removePeer:       (d)    => ipcRenderer.invoke('remove-peer', d),
  scanNetwork:      ()     => ipcRenderer.invoke('scan-network'),

  // Files
  selectFiles:      ()     => ipcRenderer.invoke('select-files'),
  selectFolder:     ()     => ipcRenderer.invoke('select-folder'),
  sendFiles:        (d)    => ipcRenderer.invoke('send-files', d),
  shareFile:        (d)    => ipcRenderer.invoke('share-file', d),
  removeSharedFile: (d)    => ipcRenderer.invoke('remove-shared-file', d),
  generateQR:       (d)    => ipcRenderer.invoke('generate-qr', d),

  // Data
  getTransferHistory: ()   => ipcRenderer.invoke('get-transfer-history'),
  getSharedFiles:     ()   => ipcRenderer.invoke('get-shared-files'),
  getStats:           ()   => ipcRenderer.invoke('get-stats'),

  // Filesystem
  openReceivedFolder: ()   => ipcRenderer.invoke('open-received-folder'),
  openFile:           (p)  => ipcRenderer.invoke('open-file', p),
  revealFile:         (p)  => ipcRenderer.invoke('reveal-file', p),
  copyToClipboard:    (t)  => ipcRenderer.invoke('copy-to-clipboard', t),
  getClipboardText:   ()   => ipcRenderer.invoke('get-clipboard-text'),

  // Window
  minimize:  () => ipcRenderer.invoke('window-minimize'),
  maximize:  () => ipcRenderer.invoke('window-maximize'),
  close:     () => ipcRenderer.invoke('window-close'),

  // Settings
  getSettings:  ()  => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // Events
  on: (channel, cb) => {
    const valid = [
      'transfer-received','transfer-sent','transfer-progress',
      'peers-updated','peer-discovered','server-ready',
      'scan-started','scan-complete','navigate'
    ];
    if (valid.includes(channel)) ipcRenderer.on(channel, (_, ...args) => cb(...args));
  },
  off: (channel, cb) => ipcRenderer.removeListener(channel, cb)
});
