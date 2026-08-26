import { test, expect } from 'playwright/test';
import { io } from 'socket.io-client';
import {
  BASE, registerUser, createGuild, createChannel, createInvite,
  joinGuild, sendMessage, setGuildSettings, getReadStates,
} from './helpers.js';

test.describe.configure({ mode: 'serial' });

let accountA;
let accountB;
let guild;
let general;
let random;

async function waitForAppReady(page, { requireSettingsOf = null, requireReadStateOf = null } = {}) {
  await expect(page.locator('#connection-status[data-state="connected"]')).toBeVisible({ timeout: 20_000 });
  if (requireSettingsOf) {
    await expect.poll(() => page.evaluate((guildId) => !!window.S?.guildSettings?.[guildId], requireSettingsOf), { timeout: 10_000 }).toBe(true);
  }
  if (requireReadStateOf) {
    await expect.poll(() => page.evaluate((channelId) => window.S?.readStates?.[channelId] !== undefined, requireReadStateOf), { timeout: 10_000 }).toBe(true);
  }
}

async function openViewer(browser, { requireSettingsOf = null } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });
  await page.addInitScript(([token, serverUrl]) => {
    window.__API_SERVER_URL__ = serverUrl;
    localStorage.setItem('da_token', token);
  }, [accountA.token, BASE]);
  await page.goto('/app');
  await waitForAppReady(page, { requireSettingsOf });
  return { context, page, consoleErrors };
}

async function openGuildChannel(page, channelId) {
  await page.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
  const item = page.locator(`.channel-item[data-ch-id="${channelId}"]`);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
  await expect(item).toHaveClass(/active/, { timeout: 10_000 });
  return item;
}

test.beforeAll(async () => {
  accountA = await registerUser('a');
  accountB = await registerUser('b');
  guild = await createGuild(accountA.token, `E2E Guild ${Date.now().toString(36)}`);
  general = guild.channels.find((c) => c.name === 'general');
  random = await createChannel(accountA.token, guild.id, 'random');
  const invite = await createInvite(accountA.token, guild.id);
  await joinGuild(accountB.token, invite.code);
});

test('unread badge appears for message in another channel', async ({ browser }) => {
  const viewer = await openViewer(browser, { requireSettingsOf: guild.id });
  await openGuildChannel(viewer.page, general.id);

  const posted = await sendMessage(accountB.token, random.id, 'ping while viewer is away');
  expect(posted.id).toBeTruthy();

  const randomItem = viewer.page.locator(`.channel-item[data-ch-id="${random.id}"]`);
  await expect(randomItem).toHaveClass(/unread/, { timeout: 10_000 });

  // rail badge shows once the guild is not the active server
  const guildBadge = viewer.page.locator(`.server-icon[data-server-id="${guild.id}"] .unread-badge`);
  await viewer.page.locator('#btn-home').click();
  await expect(viewer.page.locator('.dm-item.friends-btn')).toBeVisible({ timeout: 5000 });
  await expect(guildBadge).toBeVisible();
  await expect(guildBadge).toHaveText(/[1-9]/);

  await openGuildChannel(viewer.page, random.id);
  await expect(randomItem).not.toHaveClass(/unread/);
  await viewer.page.locator('#btn-home').click();
  await expect(guildBadge).toHaveCount(0);
  expect(viewer.consoleErrors).toEqual([]);
  await viewer.context.close();
});

test('acknowledgement persists across reload', async ({ browser }) => {
  const states = await getReadStates(accountA.token);
  const row = Array.isArray(states) ? states.find((s) => s.channel_id === random.id) : null;
  expect(row?.last_read_message_id).toBeTruthy();

  const viewer = await openViewer(browser);
  await waitForAppReady(viewer.page, { requireReadStateOf: random.id });
  await openGuildChannel(viewer.page, general.id);

  await expect(viewer.page.locator(`.channel-item[data-ch-id="${random.id}"]`)).not.toHaveClass(/unread/);
  await viewer.page.locator('#btn-home').click();
  await expect(viewer.page.locator('.dm-item.friends-btn')).toBeVisible({ timeout: 5000 });
  await expect(viewer.page.locator(`.server-icon[data-server-id="${guild.id}"] .unread-badge`)).toHaveCount(0);
  expect(viewer.consoleErrors).toEqual([]);
  await viewer.context.close();
});

test('typing indicator shows then clears', async ({ browser }) => {
  const viewer = await openViewer(browser);
  await openGuildChannel(viewer.page, general.id);

  const typer = io(`${BASE}/gateway`, { transports: ['websocket'] });
  typer.on('connect', () => typer.emit('IDENTIFY', { token: accountB.token }));
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('typer READY timeout')), 10_000);
    typer.once('READY', () => { clearTimeout(timer); resolveReady(); });
  });

  typer.emit('TYPING_START', { channel_id: general.id });
  const strip = viewer.page.locator('#typing-indicator');
  await expect(strip).toBeVisible({ timeout: 5000 });
  await expect(strip).toContainText(accountB.user.username);
  await expect(strip).toHaveAttribute('data-typing-count', '1');

  await expect(strip).toBeHidden({ timeout: 6000 });
  typer.close();

  expect(viewer.consoleErrors).toEqual([]);
  await viewer.context.close();
});

test('muted guild produces no notification flag until unmuted', async ({ browser }) => {
  await setGuildSettings(accountA.token, guild.id, { muted: 1 });
  let viewer = await openViewer(browser, { requireSettingsOf: guild.id });
  await openGuildChannel(viewer.page, general.id);

  const playCount = () => viewer.page.evaluate(() => window.NotifSound.playCount);
  expect(await playCount()).toBe(0);

  await sendMessage(accountB.token, random.id, 'should stay silent');
  await viewer.page.waitForTimeout(1000);
  expect(await playCount()).toBe(0);

  const silencedCount = await playCount();
  await viewer.context.close();

  await setGuildSettings(accountA.token, guild.id, { muted: 0 });
  viewer = await openViewer(browser, { requireSettingsOf: guild.id });
  await openGuildChannel(viewer.page, general.id);

  await sendMessage(accountB.token, random.id, 'should notify again');
  await expect.poll(playCount, { timeout: 5000 }).toBeGreaterThan(silencedCount);

  expect(viewer.consoleErrors).toEqual([]);
  await viewer.context.close();
});
