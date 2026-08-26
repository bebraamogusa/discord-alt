import { expect, test } from 'playwright/test';
import { startTestServer } from './serverHarness.js';

function captureErrors(page, ignored = []) {
  const errors = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (ignored.some(pattern => text.includes(pattern))) return;
    errors.push(`console: ${text}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  return errors;
}

// client/api.js pins requests to a hardcoded production origin;
// rewrite it so the browser talks to the local test server with real sockets.
async function pointClientAtTestServer(context, baseURL) {
  await context.route('**/api.js', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replaceAll('https://lolihentai.online', baseURL);
    await route.fulfill({ response, body });
  });
}

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
  const res = await apiCall(baseURL, null, 'POST', '/api/auth/register', {
    email: `${name}-${suffix}@example.test`,
    username: `${name}${suffix}`.slice(0, 24),
    password: 'e2e-messages-password',
  });
  expect(res.status).toBe(201);
  return { token: res.body.token, userId: res.body.user.id, username: res.body.user.username, email: `${name}-${suffix}@example.test` };
}

async function seedMessages(baseURL, token, channelId, count) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const res = await apiCall(baseURL, token, 'POST', `/api/channels/${channelId}/messages`, { content: `history seed ${i}` });
    expect(res.status).toBe(201);
    ids.push(res.body.id);
  }
  return ids;
}

async function setupGuildWithHistory(baseURL, count) {
  const owner = await registerUser(baseURL, 'owner');
  const guildRes = await apiCall(baseURL, owner.token, 'POST', '/api/guilds', { name: 'History Guild' });
  expect(guildRes.status).toBe(201);
  const guild = guildRes.body;
  const general = guild.channels.find(ch => ch.name === 'general');
  expect(general).toBeTruthy();

  const inviteRes = await apiCall(baseURL, owner.token, 'POST', `/api/channels/${general.id}/invites`, {});
  expect(inviteRes.status).toBe(201);

  const ids = await seedMessages(baseURL, owner.token, general.id, count);
  return { owner, guildId: guild.id, channelId: general.id, inviteCode: inviteRes.body.code, messageIds: ids };
}

async function joinAndBoot(page, baseURL, token) {
  await page.goto(`${baseURL}/app`);
  await page.evaluate(storedToken => localStorage.setItem('da_token', storedToken), token);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
}

async function uiLogin(page, baseURL, email, password) {
  await page.goto(`${baseURL}/app`);
  await expect(page.locator('#auth-login')).toBeVisible();
  await page.locator('#li-email').fill(email);
  await page.locator('#li-pass').fill(password);
  await page.locator('#li-btn').click();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
  await expect(page.locator('.dm-item.friends-btn')).toBeVisible();
}

async function openChannel(page, baseURL, guildId, channelId) {
  if (guildId) {
    await page.locator(`.server-icon[data-server-id="${guildId}"]`).click();
  }
  await page.locator(`.channel-item[data-ch-id="${channelId}"]`).click();
}

function topVisibleMessage(page) {
  return page.evaluate(() => {
    const wrapper = document.getElementById('messages-wrapper');
    const wrapperTop = wrapper.getBoundingClientRect().top;
    const groups = [...wrapper.querySelectorAll('.msg-group')];
    const topMost = groups.find(el => el.getBoundingClientRect().bottom >= wrapperTop);
    if (!topMost) return null;
    return { id: topMost.dataset.msgId, offset: topMost.getBoundingClientRect().top - wrapperTop };
  });
}

test('load-more pages through history preserving scroll anchor', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const member = await registerUser(testServer.baseURL, 'pager');
    const { guildId, channelId, inviteCode, messageIds } = await setupGuildWithHistory(testServer.baseURL, 120);
    expect((await apiCall(testServer.baseURL, member.token, 'POST', `/api/invites/${inviteCode}`, {})).status).toBeLessThan(300);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page, ['status of 500']);

    await joinAndBoot(page, testServer.baseURL, member.token);
    await openChannel(page, testServer.baseURL, guildId, channelId);

    await expect(page.locator('.msg-group')).toHaveCount(50);    await expect(page.locator('.msg-group').last()).toContainText('history seed 119');
    const loadMore = page.locator('#messages-load-more');
    await expect(loadMore).toBeVisible();

    const anchorBefore = await topVisibleMessage(page);
    expect(anchorBefore).toBeTruthy();

    let olderFetches = 0;
    await page.route('**/messages?*before=*', async route => {
      olderFetches += 1;
      await new Promise(resolve => setTimeout(resolve, 350));
      await route.continue();
    });

    await page.evaluate(() => {
      const btn = document.getElementById('messages-load-more');
      btn.click();
      btn.click();
    });

    await expect(page.locator('.msg-group')).toHaveCount(100);
    await expect(page.locator('.msg-group').last()).toContainText('history seed 119');
    expect(olderFetches).toBe(1);

    await page.unroute('**/messages?*before=*');

    const anchorAfter = await topVisibleMessage(page);
    expect(anchorAfter.id).toBe(anchorBefore.id);
    expect(Math.abs(anchorAfter.offset - anchorBefore.offset)).toBeLessThanOrEqual(2);

    let failedOlderFetch = false;
    await page.route('**/messages?*before=*', async route => {
      if (!failedOlderFetch) {
        failedOlderFetch = true;
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'history boom' }) });
      }
      return route.continue();
    });

    await page.evaluate(() => document.getElementById('messages-load-more').click());
    await expect(page.locator('#toast.visible.error')).toContainText('history boom');
    await expect(loadMore).toBeVisible();

    await page.unroute('**/messages?*before=*');
    await page.evaluate(() => document.getElementById('messages-load-more').click());

    await expect(page.locator('.msg-group')).toHaveCount(120);
    await expect(page.locator('.msg-group').first()).toContainText('history seed 0');
    await expect(loadMore).toBeHidden();

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});

test('search finds a seeded message and navigates to it', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const member = await registerUser(testServer.baseURL, 'searcher');
    const { guildId, channelId, inviteCode, messageIds } = await setupGuildWithHistory(testServer.baseURL, 60);
    expect((await apiCall(testServer.baseURL, member.token, 'POST', `/api/invites/${inviteCode}`, {})).status).toBeLessThan(300);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await joinAndBoot(page, testServer.baseURL, member.token);
    await openChannel(page, testServer.baseURL, guildId, channelId);
    await expect(page.locator('.msg-group')).toHaveCount(50);

    await page.locator('#btn-search').click();
    const overlay = page.locator('.search-overlay');
    await expect(overlay).toBeVisible();

    await overlay.locator('.qs-tab[data-mode="search"]').click();
    await overlay.locator('.search-input').fill('seed 7');

    const result = overlay.locator('.search-result', { hasText: 'history seed 7' });
    await expect(result).toBeVisible();
    await expect(overlay.locator('.qs-category')).toContainText('1');

    await result.click();

    const target = page.locator(`.msg-group[data-msg-id="${messageIds[7]}"]`);
    await expect(target).toBeVisible();
    await expect(target).toHaveClass(/msg-highlight/);
    await expect(target).toContainText('history seed 7');

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});

test('pin and unpin round trip with authoritative state', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const { owner, guildId, channelId, inviteCode, messageIds } = await setupGuildWithHistory(testServer.baseURL, 5);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page, ['status of 500']);

    await uiLogin(page, testServer.baseURL, owner.email, 'e2e-messages-password');
    await openChannel(page, testServer.baseURL, guildId, channelId);
    await expect(page.locator('.msg-group')).toHaveCount(5);

    const pinStateOf = messageId => page.evaluate(async id => {
      const res = await fetch(`/api/channels/${window.S.activeChannelId}/pins`, {
        headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` },
      });
      const list = await res.json();
      const local = (window.S.messages[window.S.activeChannelId] || []).find(m => m.id === id);
      return { pins: list.length, listed: list.some(pin => pin.message_id === id), localPinned: !!local?.pinned };
    }, messageId);

    await page.locator(`.msg-group[data-msg-id="${messageIds[2]}"]`).click({ button: 'right' });
    const pinItem = page.locator('#ctx-menu .ctx-item[data-action="msg_pin"]');
    await expect(pinItem).toBeVisible();
    await pinItem.click();

    await expect(page.locator('#toast.visible.success')).toBeVisible();
    let state = await pinStateOf(messageIds[2]);
    expect(state).toEqual({ pins: 1, listed: true, localPinned: true });

    await page.locator(`.msg-group[data-msg-id="${messageIds[2]}"]`).click({ button: 'right' });
    await expect(pinItem).toBeVisible();
    await pinItem.click();

    await expect(page.locator('#toast.visible.success')).toBeVisible();
    state = await pinStateOf(messageIds[2]);
    expect(state).toEqual({ pins: 0, listed: false, localPinned: false });

    const intruder = await registerUser(testServer.baseURL, 'intruder');
    expect((await apiCall(testServer.baseURL, intruder.token, 'POST', `/api/invites/${inviteCode}`, {})).status).toBeLessThan(300);
    const denied = await apiCall(testServer.baseURL, intruder.token, 'PUT', `/api/channels/${channelId}/pins/${messageIds[0]}`, {});
    expect(denied.status).toBe(403);

    await page.route('**/pins/*', route => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'pin boom' }) });
      }
      return route.continue();
    });

    await page.locator(`.msg-group[data-msg-id="${messageIds[3]}"]`).click({ button: 'right' });
    await expect(pinItem).toBeVisible();
    await pinItem.click();

    await expect(page.locator('#toast.visible.error')).toContainText('pin boom');
    state = await pinStateOf(messageIds[3]);
    expect(state).toEqual({ pins: 0, listed: false, localPinned: false });

    await page.unroute('**/pins/*');
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});
