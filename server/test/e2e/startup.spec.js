import { expect, test } from 'playwright/test';
import { startTestServer } from './serverHarness.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+eDm4VAAAAABJRU5ErkJggg==', 'base64');

async function routeClientApi(page, baseURL, observedPaths) {
  await page.addInitScript(() => {
    window.io = () => ({
      on() {},
      emit() {},
      disconnect() {},
      io: { on() {} },
    });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const target = new URL(request.url());
    observedPaths.push(`${request.method()} ${target.pathname}`);
    const headers = { ...request.headers() };
    delete headers.host;
    const response = await fetch(`${baseURL}${target.pathname}${target.search}`, {
      method: request.method(),
      headers,
      body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer(),
      redirect: 'manual',
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.route('**/files/**', async route => {
    const request = route.request();
    const target = new URL(request.url());
    const headers = { ...request.headers() };
    delete headers.host;
    const response = await fetch(`${baseURL}${target.pathname}${target.search}`, { headers });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

async function createProtectedAttachment(baseURL, token, channelId) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'startup.png');
  const uploadResponse = await fetch(`${baseURL}/api/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!uploadResponse.ok) throw new Error(`upload fixture failed: ${uploadResponse.status}`);
  const upload = await uploadResponse.json();
  const messageResponse = await fetch(`${baseURL}/api/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      content: '',
      attachments: [{ url: upload.url, filename: 'startup.png', size: png.length, mime_type: 'image/png' }],
    }),
  });
  if (!messageResponse.ok) throw new Error(`message fixture failed: ${messageResponse.status}`);
  return messageResponse.json();
}

async function registerAndCreateGuild(page, mobile) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  await page.getByRole('button', { name: /зарегистрироваться/i }).click();
  await page.locator('#reg-email').fill(`e2e-${suffix}@example.test`);
  await page.locator('#reg-name').fill(`e2e${suffix}`.slice(0, 24));
  await page.locator('#reg-pass').fill('browser-e2e-password');
  await page.locator('#reg-btn').click();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
  if (mobile) {
    await page.locator('#welcome-open-menu').click();
    await expect(page.locator('#app')).toHaveClass(/mobile-sidebar-open/);
  }

  await page.locator('#btn-add-server').click();
  await page.locator('#btn-create-server-next').click();
  await page.locator('#new-server-name').fill('E2E Bootstrap Guild');
  await page.locator('#btn-confirm-create-server').click();
  await expect(page.locator('#sidebar-server-name')).toHaveText('E2E Bootstrap Guild');
  if (mobile) {
    await expect(page.locator('#app')).not.toHaveClass(/mobile-sidebar-open/);
    await page.locator('#btn-mobile-menu').click();
    await expect(page.locator('#app')).toHaveClass(/mobile-sidebar-open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#app')).not.toHaveClass(/mobile-sidebar-open/);
  }
  return page.evaluate(() => ({
    guildId: window.S.activeServerId,
    channelId: window.S.servers.find(server => server.id === window.S.activeServerId).channels[0].id,
  }));
}

for (const viewport of [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  test(`starts, registers, bootstraps guilds, and hydrates protected attachments on ${viewport.name}`, async ({ browser }) => {
    const testServer = await startTestServer();
    const context = await browser.newContext({ viewport: viewport.viewport });
    const page = await context.newPage();
    const errors = [];
    const observedPaths = [];
    page.on('console', message => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`page: ${error.message}`));

    try {
      await routeClientApi(page, testServer.baseURL, observedPaths);
      await page.goto(`${testServer.baseURL}/app`);
      await expect(page.locator('#auth-login')).toBeVisible();
      const { guildId, channelId } = await registerAndCreateGuild(page, viewport.name === 'mobile');
      await expect.poll(() => observedPaths.includes('GET /api/guilds/@me')).toBe(true);

      await page.evaluate(channelId => window.selectChannel(channelId), channelId);
      await expect(page.locator('#msg-input')).toBeVisible();
      const alignedWidths = await page.evaluate(() => {
        const messages = document.querySelector('#messages-container')?.getBoundingClientRect().width || 0;
        const composer = document.querySelector('#input-box')?.getBoundingClientRect().width || 0;
        return { messages, composer };
      });
      expect(Math.abs(alignedWidths.messages - alignedWidths.composer)).toBeLessThanOrEqual(1);
      if (viewport.name === 'mobile') {
        await page.locator('#btn-members').click();
        await expect(page.locator('#app')).toHaveClass(/mobile-members-open/);
        await expect(page.locator('#members-panel')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#app')).not.toHaveClass(/mobile-members-open/);
        await expect(page.locator('#members-panel')).toBeHidden();
      }
      const token = await page.evaluate(() => localStorage.getItem('da_token'));
      await createProtectedAttachment(testServer.baseURL, token, channelId);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/);
      await page.evaluate(async ({ guildId, channelId }) => {
        await window.selectServer(guildId);
        await window.selectChannel(channelId);
      }, { guildId, channelId });
      await expect.poll(() => observedPaths.includes(`GET /api/guilds/${guildId}`)).toBe(true);
      const attachment = page.locator('[data-attachment-src]').first();
      await expect(attachment).toHaveAttribute('data-attachment-state', 'loaded');
      await expect(attachment).toHaveAttribute('src', /^blob:/);

      await page.locator('#btn-poll').click();
      await expect(page.locator('#modal-create-poll')).toBeVisible();
      await page.locator('#poll-cancel').click();

      await page.locator('#btn-emoji').click();
      await expect(page.locator('#emoji-picker')).not.toHaveClass(/hidden/);
      await page.locator('#emoji-picker button').first().click();
      await expect(page.locator('#msg-input')).not.toHaveValue('');

      await attachment.focus();
      await attachment.click();
      await expect(page.locator('.lightbox-overlay')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.lightbox-overlay')).toHaveCount(0);
      await expect(attachment).toBeFocused();

      const message = page.locator('.msg-group').last();
      const messageId = await message.evaluate(el => el.dataset.msgId);
      await message.click({ button: 'right' });
      await expect(page.locator('#ctx-menu')).toBeVisible();
      await page.locator('#ctx-menu [data-action="msg_reply"]').click();
      await expect(page.locator('#reply-bar')).toHaveClass(/visible/);

      await message.hover();
      await message.locator('[data-action="react"]').click();
      await expect(page.locator('.quick-react-popup')).toBeVisible();
      await page.locator('.quick-react-popup button').first().click();
      await expect.poll(() => observedPaths.includes(`PUT /api/channels/${channelId}/messages/${messageId}/reactions/%F0%9F%98%80/@me`)).toBe(true);

      await page.evaluate(() => document.getElementById('su-av-wrapper').click());
      await expect(page.locator('.status-picker')).toBeVisible();
      await page.locator('.status-picker [role="menuitemradio"]').nth(1).click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('da_status'))).toBe('idle');
      await page.evaluate(() => document.getElementById('su-av-wrapper').click());
      await expect(page.locator('.status-picker [role="menuitemradio"]').nth(1)).toHaveAttribute('aria-checked', 'true');
      expect(errors).toEqual([]);
    } finally {
      await context.close().catch(() => {});
      await testServer.close();
    }
  });
}
