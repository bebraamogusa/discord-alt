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
    password: 'e2e-dis42-password',
  });
  expect(res.status).toBe(201);
  return { token: res.body.token, userId: res.body.user.id };
}

async function setupGuildWithChannel(baseURL, count = 3) {
  const owner = await registerUser(baseURL, 'owner');
  const guildRes = await apiCall(baseURL, owner.token, 'POST', '/api/guilds', { name: 'UX Guild' });
  expect(guildRes.status).toBe(201);
  const general = guildRes.body.channels.find(ch => ch.name === 'general');
  expect(general).toBeTruthy();
  const inviteRes = await apiCall(baseURL, owner.token, 'POST', `/api/channels/${general.id}/invites`, {});
  expect(inviteRes.status).toBe(201);
  for (let i = 0; i < count; i += 1) {
    expect((await apiCall(baseURL, owner.token, 'POST', `/api/channels/${general.id}/messages`, { content: `seed ${i}` })).status).toBe(201);
  }
  return { owner, guildId: guildRes.body.id, channelId: general.id, inviteCode: inviteRes.body.code };
}

async function joinAndBoot(page, baseURL, token) {
  await page.goto(`${baseURL}/app`);
  await page.evaluate(storedToken => localStorage.setItem('da_token', storedToken), token);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
}

async function selectChannelViaJs(page, guildId, channelId) {
  await page.evaluate(({ g, c }) => {
    document.querySelector(`.server-icon[data-server-id="${g}"]`)?.click();
    document.querySelector(`.channel-item[data-ch-id="${c}"]`)?.click();
  }, { g: guildId, c: channelId });
}

test('keyboard-only modal open/close restores focus and traps tab', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const member = await registerUser(testServer.baseURL, 'kb');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await joinAndBoot(page, testServer.baseURL, member.token);

    await page.locator('#btn-add-server').focus();
    await page.keyboard.press('Enter');
    const modal = page.locator('#modal-add-server');
    await expect(modal).toBeVisible();

    let focusInfo = await page.evaluate(() => ({
      tag: document.activeElement.tagName,
      cls: document.activeElement.className,
      inside: !!document.activeElement.closest('#modal-add-server'),
    }));
    expect(focusInfo.inside).toBe(true);

    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
    focusInfo = await page.evaluate(() => ({
      inside: !!document.activeElement.closest('#modal-add-server'),
      bodyHasFocus: document.activeElement === document.body,
    }));
    expect(focusInfo.inside).toBe(true);
    expect(focusInfo.bodyHasFocus).toBe(false);

    await page.keyboard.press('Escape');
    await expect(modal).toHaveClass(/hidden/);

    focusInfo = await page.evaluate(() => ({
      id: document.activeElement.id,
      inertCount: document.querySelectorAll('body > [data-da-inert]').length,
    }));
    expect(focusInfo.id).toBe('btn-add-server');
    expect(focusInfo.inertCount).toBe(0);

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});

test('no horizontal overflow on main routes at desktop and mobile sizes', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const member = await registerUser(testServer.baseURL, 'overflow');
    const { guildId, channelId, inviteCode } = await setupGuildWithChannel(testServer.baseURL, 5);
    expect((await apiCall(testServer.baseURL, member.token, 'POST', `/api/invites/${inviteCode}`, {})).status).toBeLessThan(300);

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await pointClientAtTestServer(context, testServer.baseURL);
      const page = await context.newPage();
      const errors = captureErrors(page);

      await joinAndBoot(page, testServer.baseURL, member.token);
      await expect(page.locator('#welcome-screen')).toBeVisible();

      const horizontalOverflow = () => page.evaluate(() =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      expect(await horizontalOverflow()).toBeLessThanOrEqual(1);

      if (viewport.width <= 768) {
        // mobile keeps the sidebar translated off-screen; hit-testing a real click would stall
        await page.evaluate(() => document.querySelector('.dm-item.friends-btn')?.click());
      } else {
        await page.locator('.dm-item.friends-btn').click();
      }
      await expect(page.locator('#friends-view')).toBeVisible();
      expect(await horizontalOverflow()).toBeLessThanOrEqual(1);

      await selectChannelViaJs(page, guildId, channelId);
      await expect(page.locator('.msg-group').first()).toContainText('seed');

      // settle layout after images/embeds would load
      await page.waitForTimeout(300);
      await page.evaluate(() => document.getElementById('app')?.classList.remove('mobile-sidebar-open'));
      expect(await horizontalOverflow()).toBeLessThanOrEqual(1);

      expect(errors).toEqual([]);
      await context.close();
    }
  } finally {
    await testServer.close();
  }
});

test('language switch updates document lang attribute', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const member = await registerUser(testServer.baseURL, 'i18n');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await joinAndBoot(page, testServer.baseURL, member.token);

    const initialLang = await page.evaluate(() => document.documentElement.lang);
    expect(['en', 'ru']).toContain(initialLang);

    await page.locator('#btn-settings').click();
    await expect(page.locator('#user-settings')).toBeVisible();

    await page.locator('#us-nav-items .settings-nav-item[data-page="language"]').click();
    const target = initialLang === 'ru' ? 'en' : 'ru';
    await page.locator(`.lang-option[data-lang="${target}"]`).click();

    await expect(page.locator('#user-settings')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe(target);

    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe(target);

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});

test('attachment failure exposes filename alt and retry that recovers', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const member = await registerUser(testServer.baseURL, 'files');
    const { guildId, channelId, inviteCode } = await setupGuildWithChannel(testServer.baseURL, 1);
    expect((await apiCall(testServer.baseURL, member.token, 'POST', `/api/invites/${inviteCode}`, {})).status).toBeLessThan(300);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'photo.png');
    const uploadRes = await fetch(`${testServer.baseURL}/api/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${member.token}` },
      body: form,
    });
    expect(uploadRes.ok).toBe(true);
    const uploaded = await uploadRes.json();

    const msgRes = await apiCall(testServer.baseURL, member.token, 'POST', `/api/channels/${channelId}/messages`, {
      content: 'with attachment',
      attachments: [{ url: uploaded.url, filename: 'photo.png', size: png.length, mime_type: 'image/png' }],
    });
    expect(msgRes.status).toBe(201);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page, ['status of 500']);

    await page.route('**/files/**', route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'file boom' }),
    }));

    await joinAndBoot(page, testServer.baseURL, member.token);
    await selectChannelViaJs(page, guildId, channelId);

    const group = page.locator(`.msg-group[data-msg-id="${msgRes.body.id}"]`);
    await expect(group).toBeVisible();

    const image = group.locator('img.att-image');
    const storedName = await image.getAttribute('data-attachment-name');
    expect(storedName).toContain('photo.png');
    await expect(image).toHaveAttribute('alt', storedName);
    await expect(image).toHaveClass(/att-failed/);

    const errorBox = group.locator('.att-error');
    await expect(errorBox).toContainText(storedName);
    const retry = errorBox.locator('button.att-retry');
    await expect(retry).toBeVisible();

    await page.unroute('**/files/**');
    await page.route('**/files/**', route => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: png,
    }));
    await retry.click();

    await expect(image).not.toHaveClass(/att-failed/);
    await expect(image).toHaveAttribute('data-attachment-state', 'loaded');
    await expect(errorBox).toHaveCount(0);

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});
