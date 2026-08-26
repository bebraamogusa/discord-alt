import { expect, test, chromium } from 'playwright/test';
import { io } from 'socket.io-client';
import { startTestServer } from './serverHarness.js';

test.describe.configure({ mode: 'serial' });

// Performance contract for the incremental message feed (DIS-41):
// gateway events must touch only their own rows, reuse hydrated media,
// and never rebuild unrelated DOM or refetch attachment blobs.

let testServer;
let browser;
let owner;
let viewer;
let stranger;
let guildId;
let channelId;
let seedIds = [];
let audioMessageId;
let sentMessageId;

const SEED_COUNT = 505;
const TAIL_COUNT = 10;

function uniqueSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
}

async function apiCall(baseURL, token, method, path, payload) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseURL}${path}`, {
    method,
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

async function registerUser(baseURL, name) {
  const suffix = uniqueSuffix();
  const email = `${name}-${suffix}@example.test`;
  const res = await apiCall(baseURL, null, 'POST', '/api/auth/register', {
    email,
    username: `${name}${suffix}`.slice(0, 24),
    password: 'e2e-feed-perf-password',
  });
  expect(res.status).toBe(201);
  return { token: res.body.token, userId: res.body.user.id, email };
}

function makeWav(seconds = 3) {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function uploadAudioAttachment(baseURL, token) {
  const form = new FormData();
  form.append('file', new Blob([makeWav()], { type: 'audio/wav' }), 'perf-tone.wav');
  const res = await fetch(`${baseURL}/api/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  expect(res.status).toBe(201);
  return res.json();
}

function captureErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  return errors;
}

async function bootViewer(baseURL, token) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = captureErrors(page);
  let fileRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/files/')) fileRequests += 1;
  });
  await page.addInitScript(([serverUrl, storedToken]) => {
    window.__API_SERVER_URL__ = serverUrl;
    localStorage.setItem('da_token', storedToken);
  }, [baseURL, token]);
  await page.goto(`${baseURL}/app`);
  await expect(page.locator('#connection-status[data-state="connected"]')).toBeVisible({ timeout: 20_000 });
  await page.locator(`.server-icon[data-server-id="${guildId}"]`).click();
  await page.locator(`.channel-item[data-ch-id="${channelId}"]`).click();
  await expect(page.locator('.msg-group')).toHaveCount(50);
  return { context, page, errors, countFileRequests: () => fileRequests };
}

test.beforeAll(async () => {
  testServer = await startTestServer();
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  owner = await registerUser(testServer.baseURL, 'perfowner');
  viewer = await registerUser(testServer.baseURL, 'perfviewer');
  stranger = await registerUser(testServer.baseURL, 'perfstranger');

  const guildRes = await apiCall(testServer.baseURL, owner.token, 'POST', '/api/guilds', { name: 'Perf Guild' });
  expect(guildRes.status).toBe(201);
  const general = guildRes.body.channels.find(ch => ch.name === 'general');
  guildId = guildRes.body.id;
  channelId = general.id;

  const inviteRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${channelId}/invites`, {});
  expect(inviteRes.status).toBe(201);
  expect((await apiCall(testServer.baseURL, viewer.token, 'POST', `/api/invites/${inviteRes.body.code}`, {})).status).toBeLessThan(300);
  expect((await apiCall(testServer.baseURL, stranger.token, 'POST', `/api/invites/${inviteRes.body.code}`, {})).status).toBeLessThan(300);

  for (let i = 0; i < SEED_COUNT; i += 1) {
    const res = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${channelId}/messages`, { content: `history seed ${i}` });
    expect(res.status).toBe(201);
    seedIds.push(res.body.id);
  }

  const uploaded = await uploadAudioAttachment(testServer.baseURL, owner.token);
  const audioRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${channelId}/messages`, {
    content: 'audio attachment seed',
    attachments: [{ url: uploaded.url, filename: uploaded.filename, size: uploaded.size, mime_type: uploaded.mime_type }],
  });
  expect(audioRes.status).toBe(201);
  audioMessageId = audioRes.body.id;

  for (let i = 0; i < TAIL_COUNT; i += 1) {
    const res = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${channelId}/messages`, { content: `tail seed ${i}` });
    expect(res.status).toBe(201);
    seedIds.push(res.body.id);
  }
});

test.afterAll(async () => {
  await browser?.close();
  await testServer?.close();
});

test('sending a message appends exactly one row without re-requesting attachments', async () => {
  const { context, page, errors, countFileRequests } = await bootViewer(testServer.baseURL, viewer.token);

  await page.waitForSelector('audio[data-attachment-state="loaded"]', { timeout: 15_000 });
  const filesBefore = countFileRequests();
  expect(filesBefore).toBeGreaterThanOrEqual(1);

  await page.locator('#msg-input').fill('perf probe message');
  await page.keyboard.press('Enter');

  await expect(page.locator('.msg-group')).toHaveCount(51);
  const lastRow = page.locator('.msg-group').last();
  await expect(lastRow).toContainText('perf probe message');
  await expect(lastRow).toHaveClass(/first-in-group/);

  const counts = await page.evaluate(() => ({
    groups: document.querySelectorAll('.msg-group').length,
    heads: document.querySelectorAll('.msg-group.first-in-group').length,
  }));
  expect(counts.groups).toBe(51);
  expect(counts.heads).toBe(2);

  sentMessageId = await page.evaluate(() => document.querySelector('.msg-group:last-child')?.dataset.msgId);
  expect(sentMessageId).toBeTruthy();

  expect(countFileRequests()).toBe(filesBefore);
  expect(errors).toEqual([]);
  await context.close();
});

test('edit, reaction, and delete touch only their own row', async () => {
  const editedId = seedIds[SEED_COUNT - 1];
  const { context, page, errors, countFileRequests } = await bootViewer(testServer.baseURL, viewer.token);
  await page.waitForSelector('audio[data-attachment-state="loaded"]', { timeout: 15_000 });

  await expect(page.locator(`.msg-group[data-msg-id="${sentMessageId}"]`)).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelectorAll('.msg-group').forEach(el => { el.dataset.probe = 'p' + el.dataset.msgId; });
  });
  const filesBeforeOps = countFileRequests();

  const editRes = await apiCall(testServer.baseURL, owner.token, 'PATCH', `/api/messages/${editedId}`, { content: 'edited perf probe' });
  expect(editRes.status).toBe(200);
  const editedRow = page.locator(`.msg-group[data-msg-id="${editedId}"]`);
  await expect(editedRow).toContainText('edited perf probe');
  await expect(editedRow.locator('.msg-edited')).toBeVisible();

  const reactionRes = await apiCall(testServer.baseURL, owner.token, 'PUT', `/api/channels/${channelId}/messages/${editedId}/reactions/${encodeURIComponent('рџ‘Ќ')}/@me`, {});
  expect(reactionRes.status).toBe(200);
  await expect(editedRow.locator('.reaction-btn')).toHaveCount(1);
  await expect(editedRow.locator('.reaction-count')).toHaveText('1');

  const deleteRes = await apiCall(testServer.baseURL, viewer.token, 'DELETE', `/api/messages/${sentMessageId}`);
  expect(deleteRes.status).toBe(200);
  await expect(page.locator(`.msg-group[data-msg-id="${sentMessageId}"]`)).toHaveCount(0);
  await expect(page.locator('.msg-group')).toHaveCount(49);

  const integrity = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.msg-group')];
    return {
      probed: rows.every(el => el.dataset.probe === 'p' + el.dataset.msgId),
      audioAlive: !!document.querySelector('audio[data-attachment-state="loaded"][data-media-key]'),
    };
  });
  expect(integrity.probed).toBe(true);
  expect(integrity.audioAlive).toBe(true);
  expect(countFileRequests()).toBe(filesBeforeOps);
  expect(errors).toEqual([]);
  await context.close();
});

test('media playback survives a gateway presence event', async () => {
  const { context, page, errors } = await bootViewer(testServer.baseURL, viewer.token);

  await page.waitForSelector('audio[data-attachment-state="loaded"]', { timeout: 15_000 });
  const playback = await page.evaluate(async () => {
    const el = document.querySelector('audio[data-attachment-state="loaded"]');
    el.muted = true;
    el.dataset.playbackProbe = 'keeper';
    await el.play();
    return { started: !el.paused, time: el.currentTime };
  });
  expect(playback.started).toBe(true);

  await page.waitForFunction(() => {
    const el = document.querySelector('audio[data-attachment-state="loaded"]');
    return el && el.currentTime > 0.2;
  }, { timeout: 10_000 });

  const rowsBefore = await page.evaluate(() => document.querySelectorAll('.msg-group').length);

  const socket = io(`${testServer.baseURL}/gateway`, { transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('presence socket did not connect')), 10_000);
  });
  const ready = new Promise(resolve => socket.on('READY', resolve));
  socket.emit('IDENTIFY', { token: stranger.token });
  await ready;
  socket.emit('UPDATE_STATUS', { status: 'dnd' });

  await page.waitForTimeout(700);

  // capture before closing the stranger's socket: disconnect broadcasts them offline
  const after = await page.evaluate(() => {
    const el = document.querySelector('audio[data-attachment-state="loaded"]');
    return {
      sameElement: el?.dataset.playbackProbe === 'keeper',
      attached: !!el?.isConnected,
      playing: !!el && !el.paused,
      time: el?.currentTime ?? 0,
      rows: document.querySelectorAll('.msg-group').length,
      presenceSeen: Object.values(window.S.presences).some(p => p.status === 'dnd'),
    };
  });
  socket.close();
  expect(after.sameElement).toBe(true);
  expect(after.attached).toBe(true);
  expect(after.playing).toBe(true);
  expect(after.time).toBeGreaterThan(playback.time);
  expect(after.rows).toBe(rowsBefore);
  expect(after.presenceSeen).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});
