/* global io */
'use strict';

// ══════════════════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════════════════
let socket = null;
let serverUrl = localStorage.getItem('serverUrl') || '';
let roomId = null;
let username = null;
let localStream = null;
let screenStream = null;
let inCall = false;
let micOn = true;
let camOn = true;
const peers = new Map();
const TAURI = window.__TAURI__;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ══════════════════════════════════════════════════════════
//  DOM Helpers
// ══════════════════════════════════════════════════════════
const $ = (s) => document.querySelector(s);

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function linkify(text) {
  return esc(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`
  );
}

function genId(n) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += c[(Math.random() * c.length) | 0];
  return s;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ══════════════════════════════════════════════════════════
//  Native Notifications via Tauri
// ══════════════════════════════════════════════════════════
async function nativeNotify(title, body) {
  if (TAURI?.core) {
    try {
      await TAURI.core.invoke('send_notification', { title, body });
    } catch (e) {
      console.warn('Notification failed:', e);
    }
  }
}

// ══════════════════════════════════════════════════════════
//  Initialization
// ══════════════════════════════════════════════════════════
(function init() {
  $('#inp-server').value = serverUrl;
  $('#inp-name').value = localStorage.getItem('username') || '';
  $('#btn-connect').onclick = doConnect;
  $('#btn-disconnect').onclick = doDisconnect;

  document.querySelectorAll('#screen-connect input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doConnect();
    });
  });
})();

// ══════════════════════════════════════════════════════════
//  Connect / Disconnect
// ══════════════════════════════════════════════════════════
function doConnect() {
  serverUrl = $('#inp-server').value.trim().replace(/\/+$/, '');
  username = $('#inp-name').value.trim().slice(0, 20);
  roomId = $('#inp-room').value.trim() || genId(8);

  if (!serverUrl) { $('#inp-server').focus(); return; }
  if (!username) { $('#inp-name').focus(); return; }

  localStorage.setItem('serverUrl', serverUrl);
  localStorage.setItem('username', username);
  $('#connect-error').textContent = 'Connecting…';

  socket = io(serverUrl, {
    transports: ['websocket', 'polling'],
    timeout: 8000,
  });

  socket.on('connect', () => {
    socket.emit('join-room', { roomId, username });
    showApp();
    loadHistory();
  });

  socket.on('connect_error', (err) => {
    $('#connect-error').textContent = 'Connection failed: ' + err.message;
    socket.close();
    socket = null;
  });

  bindSocketEvents();
}

function doDisconnect() {
  if (inCall) leaveCall();
  if (socket) {
    socket.close();
    socket = null;
  }
  $('#screen-app').style.display = 'none';
  $('#screen-connect').style.display = 'flex';
  $('#messages').innerHTML = '';
  $('#connect-error').textContent = '';
}

function showApp() {
  $('#screen-connect').style.display = 'none';
  $('#screen-app').style.display = 'flex';
  $('#room-title').textContent = `# ${roomId}`;
  $('#toolbar-room').textContent = `# ${roomId}`;
  $('#my-name').textContent = username;
  $('#connect-error').textContent = '';
  document.title = `${roomId} — Discord Alt`;

  initChat();
  initDragDrop();
  initCallControls();
  initSettings();
}

// ══════════════════════════════════════════════════════════
//  Socket.io event bindings
// ══════════════════════════════════════════════════════════
function bindSocketEvents() {
  socket.on('room-users', (users) => {
    updateUserList(users);
    users.forEach((u) => {
      const el = document.getElementById('video-' + u.socketId);
      if (el) el.querySelector('.label').textContent = u.username;
    });
  });

  socket.on('chat-message', (msg) => {
    renderMessage(msg);
    if (msg.username !== username && msg.type !== 'system' && !document.hasFocus()) {
      nativeNotify('Discord Alt', `${msg.username}: ${msg.content.slice(0, 100)}`);
    }
  });

  // ── WebRTC signaling ──────────────────────────────
  socket.on('call-user-joined', ({ socketId: sid }) => {
    if (inCall) createPeer(sid, true);
  });

  socket.on('call-user-left', ({ socketId: sid }) => {
    removePeer(sid);
  });

  socket.on('webrtc-offer', async ({ from, offer }) => {
    if (!inCall) return;
    if (!peers.has(from)) createPeer(from, false);
    const { pc } = peers.get(from);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { to: from, answer: pc.localDescription });
  });

  socket.on('webrtc-answer', async ({ from, answer }) => {
    const p = peers.get(from);
    if (p) await p.pc.setRemoteDescription(answer);
  });

  socket.on('webrtc-ice-candidate', ({ from, candidate }) => {
    const p = peers.get(from);
    if (p) p.pc.addIceCandidate(candidate).catch(() => {});
  });

  socket.on('disconnect', () => toast('Connection lost, reconnecting…'));
  socket.io.on('reconnect', () => {
    socket.emit('join-room', { roomId, username });
    toast('Reconnected');
  });
}

// ══════════════════════════════════════════════════════════
//  Chat
// ══════════════════════════════════════════════════════════
let _chatReady = false;

function initChat() {
  if (_chatReady) return;
  _chatReady = true;

  $('#msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });
  $('#btn-send').onclick = sendText;
  $('#btn-attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => {
    if (e.target.files[0]) uploadFile(e.target.files[0]);
    e.target.value = '';
  };

  // Paste images from clipboard
  document.addEventListener('paste', (e) => {
    const item = Array.from(e.clipboardData?.items || []).find((i) =>
      i.type.startsWith('image/')
    );
    if (item) uploadFile(item.getAsFile());
  });

  // Copy room code
  $('#btn-copy').onclick = () => {
    navigator.clipboard.writeText(roomId).then(
      () => toast('Room code copied!'),
      () => toast('Failed to copy')
    );
  };
}

function sendText() {
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { content: text, type: 'text' });
  input.value = '';
  input.focus();
}

async function loadHistory() {
  try {
    const res = await fetch(`${serverUrl}/api/rooms/${roomId}/messages`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const msgs = await res.json();
    $('#messages').innerHTML = '';
    msgs.forEach(renderMessage);
  } catch (e) {
    console.error('Failed to load history:', e);
  }
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

function renderMessage(msg) {
  const box = $('#messages');
  const div = document.createElement('div');

  if (msg.type === 'system') {
    div.className = 'msg-system';
    div.textContent = msg.content;
  } else {
    div.className = 'msg';
    const isMe = msg.username === username;
    const cls = isMe ? 'msg-author me' : 'msg-author';
    const time = fmtTime(msg.created_at);

    if (msg.type === 'image') {
      const src = msg.content.startsWith('http') ? msg.content : serverUrl + msg.content;
      div.innerHTML =
        `<span class="${cls}">${esc(msg.username)}</span>` +
        `<span class="msg-time">${time}</span>` +
        `<div class="msg-image"><img src="${esc(src)}" loading="lazy"></div>`;
    } else if (msg.type === 'file') {
      const href = msg.content.startsWith('http') ? msg.content : serverUrl + msg.content;
      const fname = msg.content.split('/').pop();
      div.innerHTML =
        `<span class="${cls}">${esc(msg.username)}</span>` +
        `<span class="msg-time">${time}</span>` +
        `<span class="msg-text">📎 <a href="${esc(href)}" target="_blank">${esc(fname)}</a></span>`;
    } else {
      div.innerHTML =
        `<span class="${cls}">${esc(msg.username)}</span>` +
        `<span class="msg-time">${time}</span>` +
        `<span class="msg-text">${linkify(msg.content)}</span>`;
    }
  }

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ══════════════════════════════════════════════════════════
//  File Upload
// ══════════════════════════════════════════════════════════
async function uploadFile(file) {
  if (file.size > 10 * 1024 * 1024) return toast('Max file size is 10 MB');

  const fd = new FormData();
  fd.append('file', file);

  try {
    const res = await fetch(`${serverUrl}/api/upload`, { method: 'POST', body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Upload failed');
    }
    const data = await res.json();
    const ext = file.name.split('.').pop().toLowerCase();
    const type = IMAGE_EXTS.includes(ext) ? 'image' : 'file';
    socket.emit('chat-message', { content: data.url, type });
  } catch (e) {
    toast('Upload failed: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════
//  Drag & Drop
// ══════════════════════════════════════════════════════════
let _dragReady = false;

function initDragDrop() {
  if (_dragReady) return;
  _dragReady = true;

  let counter = 0;
  const ov = $('#drop-overlay');

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    counter++;
    ov.style.display = 'flex';
  });
  document.addEventListener('dragleave', () => {
    counter--;
    if (counter <= 0) { counter = 0; ov.style.display = 'none'; }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    counter = 0;
    ov.style.display = 'none';
    const f = e.dataTransfer.files[0];
    if (f) uploadFile(f);
  });
}

// ══════════════════════════════════════════════════════════
//  Settings Modal
// ══════════════════════════════════════════════════════════
let _settingsReady = false;

function initSettings() {
  if (_settingsReady) return;
  _settingsReady = true;

  $('#btn-settings').onclick = openSettings;
  $('#btn-close-settings').onclick = closeSettings;
  
  document.querySelectorAll('.settings-tab').forEach(tab => {
    if (tab.id === 'settings-logout') {
      tab.onclick = () => { closeSettings(); doDisconnect(); };
    } else {
      tab.onclick = () => switchSettingsTab(tab.dataset.tab);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = $('#settings-modal');
      if (modal && modal.style.display === 'flex') {
        closeSettings();
      }
    }
  });

  // Закрытие по клику вне контента (в правой пустой зоне)
  const contentArea = $('#settings-content-area');
  if (contentArea) {
    contentArea.addEventListener('mousedown', (e) => {
      // Если клик на самом контейнере content-area (а не на его внутренностях)
      if (e.target.id === 'settings-content-area') {
        closeSettings();
      }
    });
  }
}

function openSettings() {
  const modal = $('#settings-modal');
  modal.style.display = 'flex';
  requestAnimationFrame(() => {
    modal.classList.add('show');
  });
}

function closeSettings() {
  const modal = $('#settings-modal');
  modal.classList.remove('show');
  setTimeout(() => {
    modal.style.display = 'none';
  }, 250); // должно совпадать с CSS transition
}

function switchSettingsTab(tabId) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
  
  const tab = document.querySelector(`.settings-tab[data-tab="${tabId}"]`);
  if (tab) tab.classList.add('active');
  
  const pane = document.getElementById(`pane-${tabId}`);
  if (pane) pane.classList.add('active');
}

// ══════════════════════════════════════════════════════════
//  User List
// ══════════════════════════════════════════════════════════
function updateUserList(users) {
  $('#user-count').textContent = users.length;
  const ul = $('#user-list');
  ul.innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    const dot = u.inCall ? 'user-dot in-call' : 'user-dot';
    li.innerHTML = `<span class="${dot}"></span>${esc(u.username)}${u.inCall ? ' 🔊' : ''}`;
    ul.appendChild(li);
  });
}

// ══════════════════════════════════════════════════════════
//  Call Controls
// ══════════════════════════════════════════════════════════
let _callReady = false;

function initCallControls() {
  if (_callReady) return;
  _callReady = true;

  $('#btn-call').onclick = joinCall;
  $('#btn-hangup').onclick = leaveCall;
  $('#btn-mic').onclick = toggleMic;
  $('#btn-cam').onclick = toggleCam;
  $('#btn-screen').onclick = toggleScreen;
}

function showCallUI() {
  $('#btn-call').style.display = 'none';
  $('#btn-mic').style.display = 'flex';
  $('#btn-cam').style.display = 'flex';
  $('#btn-screen').style.display = 'flex';
  $('#btn-hangup').style.display = 'flex';
  $('#video-area').style.display = 'flex';
}

function hideCallUI() {
  $('#btn-call').style.display = 'flex';
  $('#btn-mic').style.display = 'none';
  $('#btn-cam').style.display = 'none';
  $('#btn-screen').style.display = 'none';
  $('#btn-hangup').style.display = 'none';
  $('#video-area').style.display = 'none';
  $('#video-area').innerHTML = '';
  $('#btn-mic').classList.remove('muted');
  $('#btn-cam').classList.remove('muted');
  $('#btn-screen').classList.remove('active');
}

// ══════════════════════════════════════════════════════════
//  WebRTC — Join / Leave Call
// ══════════════════════════════════════════════════════════
async function joinCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast('Cannot access camera or microphone');
    }
  }

  inCall = true;
  micOn = true;
  camOn = localStream.getVideoTracks().length > 0;
  showCallUI();
  addVideoBox('local', localStream, username + ' (You)', true);
  socket.emit('call-join');
}

function leaveCall() {
  inCall = false;
  if (socket) socket.emit('call-leave');

  for (const [id] of peers) removePeer(id);
  peers.clear();

  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }

  hideCallUI();
}

// ══════════════════════════════════════════════════════════
//  WebRTC — Peer Connection Management
// ══════════════════════════════════════════════════════════
function createPeer(targetId, initiator) {
  if (peers.has(targetId)) removePeer(targetId);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  // If screen-sharing is active, replace the video track
  if (screenStream) {
    const st = screenStream.getVideoTracks()[0];
    if (st) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(st);
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', { to: targetId, candidate: e.candidate });
    }
  };

  const remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) {
      e.streams[0].getTracks().forEach((t) => {
        if (!remoteStream.getTrackById(t.id)) remoteStream.addTrack(t);
      });
    } else {
      remoteStream.addTrack(e.track);
    }
    addVideoBox(targetId, remoteStream, '', false);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') removePeer(targetId);
  };

  peers.set(targetId, { pc, remoteStream });

  if (initiator) {
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => {
        socket.emit('webrtc-offer', { to: targetId, offer: pc.localDescription });
      });
  }
}

function removePeer(targetId) {
  const p = peers.get(targetId);
  if (p) { p.pc.close(); peers.delete(targetId); }
  const el = document.getElementById('video-' + targetId);
  if (el) el.remove();
  layoutVideos();
}

// ══════════════════════════════════════════════════════════
//  Mic / Camera / Screen Toggle
// ══════════════════════════════════════════════════════════
function toggleMic() {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; });
  $('#btn-mic').classList.toggle('muted', !micOn);
  $('#btn-mic').textContent = micOn ? '🎤' : '🔇';
}

function toggleCam() {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; });
  $('#btn-cam').classList.toggle('muted', !camOn);
}

async function toggleScreen() {
  if (screenStream) return stopScreen();

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch {
    return;
  }

  const track = screenStream.getVideoTracks()[0];
  for (const [, { pc }] of peers) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) sender.replaceTrack(track);
  }

  const localVid = document.querySelector('#video-local video');
  if (localVid) localVid.srcObject = screenStream;
  $('#btn-screen').classList.add('active');

  track.onended = () => stopScreen();
}

function stopScreen() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;

  const camTrack = localStream?.getVideoTracks()[0] || null;
  for (const [, { pc }] of peers) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) sender.replaceTrack(camTrack);
  }

  const localVid = document.querySelector('#video-local video');
  if (localVid && localStream) localVid.srcObject = localStream;
  $('#btn-screen').classList.remove('active');
}

// ══════════════════════════════════════════════════════════
//  Video Grid
// ══════════════════════════════════════════════════════════
function addVideoBox(id, stream, label, isLocal) {
  const existing = document.getElementById('video-' + id);
  if (existing) {
    existing.querySelector('video').srcObject = stream;
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'video-box' + (isLocal ? ' local' : '');
  wrap.id = 'video-' + id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;
  video.srcObject = stream;

  const lbl = document.createElement('span');
  lbl.className = 'label';
  lbl.textContent = label || '';

  wrap.appendChild(video);
  wrap.appendChild(lbl);
  $('#video-area').appendChild(wrap);
  layoutVideos();
}

function layoutVideos() {
  const area = $('#video-area');
  const count = area.children.length;
  if (count === 0) return;

  const w = count <= 2 ? 'calc(50% - 4px)' : 'calc(33.3% - 6px)';
  const h = count <= 2 ? '220px' : '170px';

  Array.from(area.children).forEach((box) => {
    box.style.width = count === 1 ? '360px' : w;
    box.style.height = h;
  });
}
