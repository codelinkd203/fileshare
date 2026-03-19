/* FileShare v1.1 — Renderer */

const state = {
  deviceInfo: null,
  peers: [],
  selectedPeer: null,
  queuedFiles: [],
  transferHistory: [],
  sharedFiles: [],
  settings: {},
  currentPage: 'send',
  historyFilter: 'all',
  scanning: false
};

// ─── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupPlatform();
  setupNavigation();
  setupWindowControls();
  setupSendPage();
  setupReceivePage();
  setupSharePage();
  setupHistoryPage();
  setupSettingsPage();
  setupEventListeners();
  loadInitialData();
  pollServerReady();
  setInterval(refreshStats, 5000);
});

// ─── Platform detection ────────────────────────────────────
async function setupPlatform() {
  const info = await window.api.getDeviceInfo().catch(() => null);
  const isMac = info?.isMac || navigator.platform.startsWith('Mac');
  const el = document.getElementById('app');
  el.classList.remove('platform-unknown');
  el.classList.add(isMac ? 'platform-mac' : 'platform-win');
}

// ─── Settings ─────────────────────────────────────────────
async function loadSettings() {
  state.settings = await window.api.getSettings().catch(() => ({}));
  applyTheme(state.settings.theme || 'dark');
  applyAccent(state.settings.accentColor || '#ffffff');
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  state.settings.theme = t;
}
function applyAccent(c) {
  document.documentElement.style.setProperty('--accent', c);
  state.settings.accentColor = c;
}

// ─── Server ready ──────────────────────────────────────────
async function pollServerReady() {
  for (let i = 0; i < 25; i++) {
    const info = await window.api.getDeviceInfo().catch(() => null);
    if (info?.ip && info.port) { setServerOnline(info); return; }
    await sleep(400);
  }
}

function setServerOnline(data) {
  document.getElementById('server-status-dot').className = 'status-dot pulse';
  document.getElementById('server-status-text').textContent = `${data.ip}:${data.port}`;
  state.deviceInfo = { ...state.deviceInfo, ...data };
  updateDeviceDisplay();
  generateQR();
  updateCurlSnippet();
}

function updateDeviceDisplay() {
  if (!state.deviceInfo) return;
  const name = state.settings.deviceName || state.deviceInfo.name;
  document.getElementById('my-device-name').textContent = name;
  document.getElementById('my-device-ip').textContent   = `${state.deviceInfo.ip}:${state.deviceInfo.port}`;
  document.getElementById('recv-ip').textContent   = state.deviceInfo.ip;
  document.getElementById('recv-name').textContent = name;
}

function updateCurlSnippet() {
  if (!state.deviceInfo) return;
  const el = document.getElementById('curl-snippet');
  if (el) el.textContent = `curl -X POST http://${state.deviceInfo.ip}:${state.deviceInfo.port}/upload \\
  -H "x-sender-name: MyPhone" \\
  -F "files=@photo.jpg"`;
}

async function generateQR() {
  if (!state.deviceInfo) return;
  const url = `fileshare://${state.deviceInfo.ip}:${state.deviceInfo.port}`;
  const qr = await window.api.generateQR({ url }).catch(() => null);
  if (qr) document.getElementById('qr-code').src = qr;
}

// ─── Stats ─────────────────────────────────────────────────
async function refreshStats() {
  const stats = await window.api.getStats().catch(() => null);
  if (!stats) return;
  document.getElementById('stat-sent').textContent      = formatBytes(stats.sent);
  document.getElementById('stat-recv').textContent      = formatBytes(stats.received);
  document.getElementById('stat-transfers').textContent = stats.transfers;
}

// ─── Navigation ────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
}
function navigateTo(page) {
  state.currentPage = page;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'history') renderHistory();
  if (page === 'share')   renderSharedFiles();
}

// ─── Window controls ───────────────────────────────────────
function setupWindowControls() {
  document.getElementById('btn-close')?.addEventListener('click',    () => window.api.close());
  document.getElementById('btn-minimize')?.addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-maximize')?.addEventListener('click', () => window.api.maximize());
}

// ─── Network scan ──────────────────────────────────────────
async function triggerScan() {
  if (state.scanning) return;
  state.scanning = true;
  const scanBtns = [
    document.getElementById('btn-scan-titlebar'),
    document.getElementById('btn-scan-sidebar')
  ];
  scanBtns.forEach(b => b?.classList.add('scanning'));
  document.getElementById('btn-scan-sidebar')?.classList.add('spinning');
  showToast('Scanning network for devices…', 'info');
  await window.api.scanNetwork().catch(() => null);
  state.scanning = false;
  scanBtns.forEach(b => b?.classList.remove('scanning'));
  document.getElementById('btn-scan-sidebar')?.classList.remove('spinning');
}

// ─── Send page ─────────────────────────────────────────────
function setupSendPage() {
  const dz = document.getElementById('drop-zone');

  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', e => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag-over'); });
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(f => addToQueue({ name: f.name, size: f.size, path: f.path || '' }));
  });
  dz.addEventListener('click', e => { if (!e.target.closest('.btn')) browseFiles(); });

  document.getElementById('btn-browse-files').addEventListener('click',   e => { e.stopPropagation(); browseFiles(); });
  document.getElementById('btn-browse-folder').addEventListener('click',  e => { e.stopPropagation(); browseFolder(); });
  document.getElementById('btn-send-clipboard').addEventListener('click', e => { e.stopPropagation(); sendClipboard(); });
  document.getElementById('btn-send').addEventListener('click',       sendFiles);
  document.getElementById('btn-clear-queue').addEventListener('click', clearQueue);
  document.getElementById('target-clear').addEventListener('click',   clearTarget);
  document.getElementById('btn-scan-titlebar').addEventListener('click', triggerScan);
  document.getElementById('btn-scan-sidebar').addEventListener('click',  triggerScan);
  document.getElementById('btn-add-peer').addEventListener('click', showAddPeerModal);
}

async function browseFiles() {
  const files = await window.api.selectFiles();
  files.forEach(p => addToQueue({ name: p.split(/[\\/]/).pop(), size: 0, path: p }));
}
async function browseFolder() {
  const folder = await window.api.selectFolder();
  if (folder) {
    const name = folder.split(/[\\/]/).pop();
    addToQueue({ name: name + '/', size: 0, path: folder, isFolder: true });
  }
}
async function sendClipboard() {
  const text = await window.api.getClipboardText();
  if (!text?.trim()) { showToast('Clipboard is empty', 'error'); return; }
  // Save clipboard as a temp .txt file
  addToQueue({ name: 'clipboard.txt', size: text.length, path: '__clipboard__', clipboardText: text });
}

function addToQueue(file) {
  state.queuedFiles.push({ ...file, id: Date.now() + Math.random() });
  renderQueue();
}
function removeFromQueue(id) {
  state.queuedFiles = state.queuedFiles.filter(f => f.id !== id);
  renderQueue();
}
function clearQueue() { state.queuedFiles = []; renderQueue(); }

function renderQueue() {
  const c = document.getElementById('queued-files');
  const footer = document.getElementById('send-footer');
  if (!state.queuedFiles.length) { c.innerHTML = ''; footer.style.display = 'none'; return; }
  footer.style.display = 'flex';
  c.innerHTML = state.queuedFiles.map(f => `
    <div class="queued-file">
      <span class="qf-icon">${getFileEmoji(f.name)}</span>
      <span class="qf-name">${esc(f.name)}</span>
      <span class="qf-size">${f.size > 0 ? formatBytes(f.size) : f.clipboardText ? `${f.clipboardText.length} chars` : '—'}</span>
      <button class="qf-rm" data-id="${f.id}">✕</button>
    </div>
  `).join('');
  c.querySelectorAll('.qf-rm').forEach(btn => btn.addEventListener('click', () => removeFromQueue(parseFloat(btn.dataset.id))));
}

async function sendFiles() {
  if (!state.selectedPeer) { showToast('Select a target device first', 'error'); return; }
  if (!state.queuedFiles.length) { showToast('Add files to the queue first', 'error'); return; }

  const prog     = document.getElementById('progress-card');
  const fill     = document.getElementById('progress-fill');
  const lbl      = document.getElementById('progress-label');
  prog.classList.remove('hidden');
  lbl.textContent = `Sending to ${state.selectedPeer.name}…`;

  let p = 0;
  const ticker = setInterval(() => { p = Math.min(p + Math.random() * 12, 88); fill.style.width = p + '%'; }, 200);

  // Handle clipboard items — we can't easily send clipboard text as a real file from renderer,
  // so filter those out and show a warning (in a real app you'd write to tmp via IPC)
  const realFiles = state.queuedFiles.filter(f => f.path && f.path !== '__clipboard__');
  if (realFiles.length < state.queuedFiles.length) {
    showToast('Clipboard items skipped (not yet supported for send)', 'info');
  }
  if (!realFiles.length) {
    clearInterval(ticker);
    prog.classList.add('hidden');
    return;
  }

  const result = await window.api.sendFiles({
    targetIP:   state.selectedPeer.ip,
    targetPort: state.selectedPeer.port || 3847,
    filePaths:  realFiles.map(f => f.path),
    senderName: state.settings.deviceName || state.deviceInfo?.name
  });

  clearInterval(ticker);
  fill.style.width = '100%';
  setTimeout(() => { prog.classList.add('hidden'); fill.style.width = '0'; }, 1400);

  if (result.success) {
    showToast(`✓ Sent ${realFiles.length} file(s) to ${state.selectedPeer.name}`, 'success');
    clearQueue();
    refreshStats();
  } else {
    showToast(`Send failed: ${result.error}`, 'error');
  }
}

function selectTarget(peer) {
  state.selectedPeer = peer;
  document.getElementById('target-empty').classList.add('hidden');
  document.getElementById('target-selected').classList.remove('hidden');
  const displayName = peer.name && peer.name.length > 22 ? peer.name.slice(0,22) + '…' : peer.name;
  document.getElementById('target-name').textContent = displayName;
  document.getElementById('target-ip').textContent   = `${peer.ip}:${peer.port || 3847}`;
  document.getElementById('target-device-icon').textContent = getPlatformEmoji(peer.platform);
  document.querySelectorAll('.peer-item').forEach(el => el.classList.toggle('selected', el.dataset.peerId === peer.id));
}
function clearTarget() {
  state.selectedPeer = null;
  document.getElementById('target-empty').classList.remove('hidden');
  document.getElementById('target-selected').classList.add('hidden');
  document.querySelectorAll('.peer-item').forEach(el => el.classList.remove('selected'));
}

// ─── Peers ─────────────────────────────────────────────────
function renderPeers() {
  const list = document.getElementById('peers-list');
  document.getElementById('peer-count').textContent = state.peers.length;

  if (!state.peers.length) {
    list.innerHTML = `<div class="empty-peers">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="opacity:.25"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/></svg>
      <span>No devices found yet</span>
    </div>`;
    return;
  }

  list.innerHTML = state.peers.map(p => `
    <div class="peer-item ${state.selectedPeer?.id === p.id ? 'selected' : ''}" data-peer-id="${p.id}">
      <span class="peer-icon">${getPlatformEmoji(p.platform)}</span>
      <div class="peer-info">
        <div class="peer-name">${esc(p.name || 'Unknown')}</div>
        <div class="peer-meta">${p.ip} <span class="peer-badge ${p.discovery || 'manual'}">${p.discovery === 'auto' ? 'auto' : p.discovery === 'scan' ? 'scan' : 'manual'}</span></div>
      </div>
      <button class="peer-remove" data-peer-id="${p.id}" title="Remove">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.peer-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('peer-remove')) return;
      const peer = state.peers.find(p => p.id === el.dataset.peerId);
      if (peer) { selectTarget(peer); if (state.currentPage !== 'send') navigateTo('send'); }
    });
  });
  list.querySelectorAll('.peer-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await window.api.removePeer({ peerId: btn.dataset.peerId });
      if (state.selectedPeer?.id === btn.dataset.peerId) clearTarget();
    });
  });
}

function showAddPeerModal() {
  showModal('Add Device by IP', `
    <div class="modal-field">
      <label>IP Address</label>
      <input type="text" id="peer-ip-input" placeholder="192.168.1.42" autocomplete="off">
    </div>
    <div class="modal-field">
      <label>Port (optional, default 3847)</label>
      <input type="text" id="peer-port-input" placeholder="3847" autocomplete="off">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="btn-connect-peer">Connect</button>
    </div>
  `);
  document.getElementById('peer-ip-input')?.focus();
  document.getElementById('btn-connect-peer')?.addEventListener('click', async () => {
    const ip   = document.getElementById('peer-ip-input')?.value.trim();
    const port = document.getElementById('peer-port-input')?.value.trim() || '3847';
    if (!ip) { showToast('Enter an IP address', 'error'); return; }
    const result = await window.api.addManualPeer({ ip, port: parseInt(port) });
    if (result.success) { showToast(`Connected to ${result.peer.name}`, 'success'); closeModal(); }
    else showToast(result.error, 'error');
  });
}

// ─── Receive page ──────────────────────────────────────────
function setupReceivePage() {
  document.getElementById('copy-ip-btn').addEventListener('click', async () => {
    const ip = state.deviceInfo?.ip || '';
    await window.api.copyToClipboard(`${ip}:${state.deviceInfo?.port || 3847}`);
    showToast('Copied!', 'success');
  });
  document.getElementById('copy-curl-btn')?.addEventListener('click', async () => {
    const el = document.getElementById('curl-snippet');
    if (el) { await window.api.copyToClipboard(el.textContent); showToast('Copied!', 'success'); }
  });
  document.getElementById('open-folder-card')?.addEventListener('click', () => window.api.openReceivedFolder());
}

function renderReceivedItems() {
  const recvd = state.transferHistory.filter(t => t.type === 'received').slice(0, 30);
  const c = document.getElementById('received-items');
  c.innerHTML = recvd.length ? recvd.map(renderTransferItem).join('') : '<div class="empty-state">No files received yet</div>';
}

// ─── Share Links ───────────────────────────────────────────
function setupSharePage() {
  document.getElementById('btn-create-share').addEventListener('click', async () => {
    const files = await window.api.selectFiles();
    if (!files.length) return;
    showModal('Create Share Link', `
      <div class="modal-field">
        <label>File</label>
        <input type="text" value="${esc(files[0].split(/[\\/]/).pop())}" readonly style="opacity:.6">
      </div>
      <div class="modal-field">
        <label>Expiry (minutes, 0 = never)</label>
        <input type="number" id="share-ttl" value="60" min="0">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="btn-confirm-share">Create</button>
      </div>
    `);
    document.getElementById('btn-confirm-share')?.addEventListener('click', async () => {
      const ttl = parseInt(document.getElementById('share-ttl')?.value) || 0;
      closeModal();
      const result = await window.api.shareFile({ filePath: files[0], ttl: ttl || null });
      if (result.url) {
        state.sharedFiles.unshift(result);
        renderSharedFiles();
        showToast('Share link created!', 'success');
        setTimeout(() => showQRModal(result), 250);
      } else {
        showToast('Failed to create share link', 'error');
      }
    });
  });
}

async function renderSharedFiles() {
  state.sharedFiles = await window.api.getSharedFiles();
  const c = document.getElementById('shared-files-list');
  if (!state.sharedFiles.length) { c.innerHTML = '<div class="empty-state">No active share links</div>'; return; }
  c.innerHTML = state.sharedFiles.map(f => `
    <div class="shared-card">
      <span class="sc-icon">${getFileEmoji(f.originalName)}</span>
      <div class="sc-info">
        <div class="sc-name">${esc(f.originalName)}</div>
        <div class="sc-url">${esc(f.url)}</div>
        <div class="sc-meta">${f.expires ? `Expires ${timeAgo(f.expires)}` : 'No expiry'}</div>
      </div>
      <div class="sc-actions">
        <button class="action-btn" onclick="_copyURL('${esc(f.url)}')">Copy URL</button>
        <button class="action-btn" onclick="_showQR('${f.id}')">QR</button>
        <button class="action-btn btn-danger" onclick="_deleteShare('${f.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

window._copyURL = async (url) => {
  await window.api.copyToClipboard(url);
  showToast('URL copied!', 'success');
};
window._showQR = (id) => {
  const f = state.sharedFiles.find(s => s.id === id);
  if (f) showQRModal(f);
};
window._deleteShare = async (id) => {
  await window.api.removeSharedFile({ shareId: id });
  state.sharedFiles = state.sharedFiles.filter(f => f.id !== id);
  renderSharedFiles();
  showToast('Share link removed', 'info');
};

async function showQRModal(shareInfo) {
  const qr = await window.api.generateQR({ url: shareInfo.url });
  showModal(`QR — ${shareInfo.originalName}`, `
    <div class="qr-modal">
      <img src="${qr}" alt="QR Code">
      <div class="qr-modal-url">${esc(shareInfo.url)}</div>
      <div style="display:flex;gap:8px;margin-top:4px;">
        <button class="btn btn-ghost btn-sm" onclick="_copyURL('${esc(shareInfo.url)}')">Copy URL</button>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Close</button>
      </div>
    </div>
  `);
}

// ─── History ───────────────────────────────────────────────
function setupHistoryPage() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.historyFilter = btn.dataset.filter;
      renderHistory();
    });
  });
}
function renderHistory() {
  const items = state.transferHistory.filter(t => state.historyFilter === 'all' || t.type === state.historyFilter);
  const c = document.getElementById('history-list');
  c.innerHTML = items.length ? items.map(renderTransferItem).join('') : '<div class="empty-state">No transfers yet</div>';
}

function renderTransferItem(t) {
  const isSent = t.type === 'sent';
  const fileCount = t.files?.length || 0;
  const firstName = t.files?.[0]?.name || 'Unknown';
  const label  = fileCount > 1 ? `${fileCount} files` : firstName;
  const party  = isSent ? (t.recipientName || t.recipient || '—') : (t.sender || '—');
  const sizeTxt = t.size ? ` · ${formatBytes(t.size)}` : '';
  const fp = t.files?.[0]?.path;

  return `<div class="transfer-item">
    <div class="ti-icon ${isSent ? 'sent' : 'recv'}">${isSent ? '↑' : '↓'}</div>
    <div class="ti-info">
      <div class="ti-title">${esc(label)}</div>
      <div class="ti-sub">${isSent ? 'To' : 'From'} ${esc(party)}${sizeTxt}</div>
    </div>
    <div class="ti-actions">
      ${!isSent && fp ? `<button class="action-btn" onclick="window.api.revealFile('${esc(fp)}')">Show</button>` : ''}
      ${!isSent && fp ? `<button class="action-btn" onclick="window.api.openFile('${esc(fp)}')">Open</button>`  : ''}
    </div>
    <div class="ti-meta">
      <div class="ti-time">${timeAgo(t.timestamp)}</div>
      <div class="ti-status s-${t.status}">${t.status}</div>
    </div>
  </div>`;
}

// ─── Settings ──────────────────────────────────────────────
function setupSettingsPage() {
  const s = state.settings;
  const dn = document.getElementById('setting-device-name');
  const th = document.getElementById('setting-theme');
  const no = document.getElementById('setting-notifications');
  if (dn) dn.value    = s.deviceName || '';
  if (th) th.value    = s.theme || 'dark';
  if (no) no.checked  = s.notifications !== false;

  th?.addEventListener('change', () => applyTheme(th.value));

  document.querySelectorAll('.cp').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === (s.accentColor || '#ffffff'));
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cp').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyAccent(btn.dataset.color);
    });
  });

  document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
    const updated = {
      ...state.settings,
      deviceName:    document.getElementById('setting-device-name')?.value || state.deviceInfo?.name,
      theme:         document.getElementById('setting-theme')?.value || 'dark',
      accentColor:   state.settings.accentColor,
      notifications: document.getElementById('setting-notifications')?.checked
    };
    await window.api.saveSettings(updated);
    state.settings = updated;
    updateDeviceDisplay();
    showToast('Settings saved', 'success');
  });
}

// ─── Event listeners ───────────────────────────────────────
function setupEventListeners() {
  window.api.on('server-ready',      data => setServerOnline(data));
  window.api.on('navigate',          page => navigateTo(page));

  window.api.on('peers-updated', peers => {
    state.peers = peers;
    renderPeers();
  });

  window.api.on('peer-discovered', peer => {
    showToast(`📡 Found ${peer.name} (${peer.ip})`, 'success');
  });

  window.api.on('transfer-received', transfer => {
    state.transferHistory.unshift(transfer);
    if (state.currentPage === 'receive') renderReceivedItems();
    if (state.currentPage === 'history') renderHistory();
    refreshStats();
  });

  window.api.on('transfer-sent', transfer => {
    const ex = state.transferHistory.find(t => t.id === transfer.id);
    if (ex) Object.assign(ex, transfer); else state.transferHistory.unshift(transfer);
    if (state.currentPage === 'history') renderHistory();
    refreshStats();
  });

  window.api.on('transfer-progress', data => {
    document.getElementById('progress-fill').style.width = (data.percent || 0) + '%';
  });

  window.api.on('scan-started', () => {
    document.getElementById('btn-scan-titlebar')?.classList.add('scanning');
  });
  window.api.on('scan-complete', data => {
    document.getElementById('btn-scan-titlebar')?.classList.remove('scanning');
    showToast(data.found > 0 ? `Found ${data.found} device(s)` : 'No new devices found', 'info');
  });
}

// ─── Load initial data ─────────────────────────────────────
async function loadInitialData() {
  state.deviceInfo = await window.api.getDeviceInfo().catch(() => null);
  updateDeviceDisplay();
  generateQR();
  updateCurlSnippet();

  const [peers, history] = await Promise.all([
    window.api.getPeers().catch(() => []),
    window.api.getTransferHistory().catch(() => [])
  ]);
  state.peers = peers;
  state.transferHistory = history;
  renderPeers();
  renderReceivedItems();
  refreshStats();
}

// ─── Modal ─────────────────────────────────────────────────
function showModal(title, body) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML    = body;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}
window.closeModal = () => document.getElementById('modal-backdrop').classList.add('hidden');
document.getElementById('modal-close')?.addEventListener('click', closeModal);
document.getElementById('modal-backdrop')?.addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

// ─── Toast ─────────────────────────────────────────────────
window.showToast = (msg, type = 'info') => {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span><span>${esc(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.cssText = 'opacity:0;transform:translateY(6px);transition:all 200ms ease'; setTimeout(() => t.remove(), 200); }, 3000);
};

// ─── Utilities ─────────────────────────────────────────────
function formatBytes(b) {
  if (!b || b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(Math.max(b,1)) / Math.log(1024));
  return `${(b / 1024 ** i).toFixed(1)} ${u[i]}`;
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function getFileEmoji(name = '') {
  if (name.endsWith('/') || name.endsWith('\\')) return '📁';
  const e = name.split('.').pop()?.toLowerCase();
  const m = { pdf:'📄',doc:'📝',docx:'📝',txt:'📝',xls:'📊',xlsx:'📊',csv:'📊',
    ppt:'📽',pptx:'📽',jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼',svg:'🖼',
    mp4:'🎬',mov:'🎬',avi:'🎬',mkv:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',m4a:'🎵',
    zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',dmg:'💿',exe:'⚙️',
    js:'⚡',ts:'⚡',py:'🐍',go:'🔵',rs:'🦀',json:'🔧',html:'🌐',css:'🎨',sh:'⚡' };
  return m[e] || '📄';
}

function getPlatformEmoji(platform = '') {
  if (platform.includes('darwin') || platform.includes('mac')) return '🍎';
  if (platform.includes('win'))   return '🪟';
  if (platform.includes('linux')) return '🐧';
  if (platform.includes('ios') || platform.includes('iphone') || platform.includes('ipad')) return '📱';
  if (platform.includes('android')) return '🤖';
  return '💻';
}

function esc(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
