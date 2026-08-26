import { expect, test } from 'playwright/test';
import { startTestServer } from './serverHarness.js';

const OWNER_PASSWORD = 'e2e-guildset-owner-pass';
const MEMBER_PASSWORD = 'e2e-guildset-member-pass';

const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BANNER_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

async function registerUser(baseURL, name, password) {
  const suffix = uniqueSuffix();
  const email = `${name}-${suffix}@example.test`;
  const username = `${name}${suffix}`.slice(0, 24);
  const res = await apiCall(baseURL, null, 'POST', '/api/auth/register', { email, username, password });
  expect(res.status).toBe(201);
  return { token: res.body.token, userId: res.body.user.id, username, email, password };
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

async function bootWithToken(page, baseURL, token) {
  await page.goto(`${baseURL}/app`);
  await page.evaluate(stored => localStorage.setItem('da_token', stored), token);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
}

async function openServerSettings(page, guildId) {
  await page.locator(`.server-icon[data-server-id="${guildId}"]`).click({ button: 'right' });
  await page.locator('#ctx-menu .ctx-item[data-action="srv_settings"]').click();
  await expect(page.locator('#server-settings')).not.toHaveClass(/hidden/);
}

test('guild icon/banner persist through API and render after reload; role color integer round trip', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const owner = await registerUser(testServer.baseURL, 'gowner', OWNER_PASSWORD);
    const guildRes = await apiCall(testServer.baseURL, owner.token, 'POST', '/api/guilds', { name: 'Settings Guild' });
    expect(guildRes.status).toBe(201);
    const guild = guildRes.body;

    const roleRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/guilds/${guild.id}/roles`, {
      name: 'Painted',
      color: 0,
      permissions: '0',
    });
    expect(roleRes.status).toBe(201);
    const roleId = roleRes.body.id;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await uiLogin(page, testServer.baseURL, owner.email, OWNER_PASSWORD);
    await page.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await expect(page.locator('.channel-item').first()).toBeVisible();

    await openServerSettings(page, guild.id);

    const iconInput = page.locator('#ss-icon');
    const bannerInput = page.locator('#ss-banner');
    await expect(iconInput).toBeVisible();
    await expect(bannerInput).toBeVisible();
    await iconInput.fill(ICON_DATA_URL);
    await bannerInput.fill(BANNER_DATA_URL);
    await page.locator('#ss-save-overview').click();
    await expect(page.locator('#toast.visible.success')).toBeVisible();

    // authoritative persistence via API
    const persisted = await page.evaluate(async guildId => {
      const res = await fetch(`/api/guilds/${guildId}`, {
        headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` },
      });
      return res.json();
    }, guild.id);
    expect(persisted.icon).toBe(ICON_DATA_URL);
    expect(persisted.banner).toBe(BANNER_DATA_URL);

    // survives reload and renders in the server rail
    await page.reload();
    await expect(page.locator(`.server-icon[data-server-id="${guild.id}"] img`)).toHaveAttribute('src', ICON_DATA_URL);

    await openServerSettings(page, guild.id);
    await expect(page.locator('#ss-icon')).toHaveValue(ICON_DATA_URL);
    await expect(page.locator('#ss-banner')).toHaveValue(BANNER_DATA_URL);

    // role color round trip through the editor
    await page.locator('[data-ss-page="roles"]').click();
    const roleRow = page.locator(`tr[data-role-id="${roleId}"]`);
    await expect(roleRow.locator('.edit-role-btn')).toBeVisible();
    await roleRow.locator('.edit-role-btn').click();

    const newHex = '#12ab34';
    await expect(page.locator('#re-color')).toHaveValue('#000000');
    await page.locator('#re-name').fill('Repainted');
    await page.locator('#re-color').fill(newHex);
    await page.locator('#save-role-btn').click();
    await expect(page.locator('#toast.visible.success')).toBeVisible();

    const expectedInt = Number.parseInt(newHex.slice(1), 16);
    const savedRole = await page.evaluate(async ({ guildId, roleId }) => {
      const res = await fetch(`/api/guilds/${guildId}`, {
        headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` },
      });
      const data = await res.json();
      return data.roles.find(r => r.id === roleId);
    }, { guildId: guild.id, roleId });
    expect(savedRole.color).toBe(expectedInt);

    await expect(roleRow).toContainText('Repainted');
    await expect(roleRow.locator('.role-pill')).toHaveAttribute('style', /background:\s*#12ab34/i);

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});

test('overwrite CRUD via UI denies then restores member messaging (two accounts)', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const owner = await registerUser(testServer.baseURL, 'ovown', OWNER_PASSWORD);
    const member = await registerUser(testServer.baseURL, 'ovmem', MEMBER_PASSWORD);

    const guildRes = await apiCall(testServer.baseURL, owner.token, 'POST', '/api/guilds', { name: 'Overwrite Guild' });
    expect(guildRes.status).toBe(201);
    const guild = guildRes.body;
    const general = guild.channels.find(ch => ch.name === 'general');
    expect(general).toBeTruthy();

    const inviteRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${general.id}/invites`, {});
    expect(inviteRes.status).toBe(201);
    expect((await apiCall(testServer.baseURL, member.token, 'POST', `/api/invites/${inviteRes.body.code}`, {})).status).toBeLessThan(300);

    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(ownerContext, testServer.baseURL);
    const ownerPage = await ownerContext.newPage();
    const ownerErrors = captureErrors(ownerPage);

    await uiLogin(ownerPage, testServer.baseURL, owner.email, OWNER_PASSWORD);
    await ownerPage.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await ownerPage.locator(`.channel-item[data-ch-id="${general.id}"]`).click();
    await expect(ownerPage.locator('#msg-input')).toBeVisible();

    // open channel settings > permissions
    await ownerPage.locator(`.channel-item[data-ch-id="${general.id}"]`).click({ button: 'right' });
    await ownerPage.locator('#ctx-menu .ctx-item[data-action="ch_edit"]').click();
    const dialog = ownerPage.locator('.da-dialog-box.da-dialog-wide');
    await expect(dialog).toBeVisible();
    await dialog.locator('.cs-tab[data-tab="permissions"]').click();
    await expect(dialog.locator('#cs-add-perm')).toBeVisible();
    await expect(dialog.locator('#cs-perm-empty')).toBeVisible();

    // create @everyone deny-send overwrite
    await dialog.locator('#cs-add-perm').click();
    const form = ownerPage.locator('#cow-overlay');
    await form.locator('#cow-type').selectOption('role');
    await form.locator('#cow-target').selectOption(guild.id); // everyone role id == guild id
    await form.locator('select[data-perm="send_messages"]').selectOption('deny');
    await form.locator('#cow-save').click();
    await expect(ownerPage.locator('#toast.visible.success')).toContainText('Переопределение сохранено');
    const overwriteRow = dialog.locator('.cs-perm-row', { hasText: '@everyone' });
    await expect(overwriteRow).toBeVisible();

    // effective denial for the second account over real sockets
    const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(memberContext, testServer.baseURL);
    const memberPage = await memberContext.newPage();
    // the test deliberately triggers 403s while messaging is denied
    const memberErrors = captureErrors(memberPage, ['status of 403']);

    await uiLogin(memberPage, testServer.baseURL, member.email, MEMBER_PASSWORD);
    await memberPage.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await expect(memberPage.locator('.channel-item[data-ch-id="' + general.id + '"]')).toBeVisible();
    await memberPage.locator(`.channel-item[data-ch-id="${general.id}"]`).click();
    await expect(memberPage.locator('#msg-input')).toBeVisible();

    const blockedApi = await memberPage.evaluate(async channelId => {
      const res = await fetch(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${localStorage.getItem('da_token')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'should be blocked' }),
      });
      return { status: res.status, body: await res.json() };
    }, general.id);
    expect(blockedApi.status).toBe(403);
    expect(blockedApi.body.error).toContain('SEND_MESSAGES');

    await memberPage.locator('#msg-input').fill('blocked attempt');
    await memberPage.locator('#msg-input').press('Enter');
    await expect(memberPage.locator('#toast.visible.error')).toContainText('SEND_MESSAGES');

    // owner deletes the overwrite
    await overwriteRow.locator('.cs-perm-del').click();
    await ownerPage.locator('#dac-ok').click();
    await expect(ownerPage.locator('#toast.visible.success')).toContainText('удалено');
    await expect(dialog.locator('#cs-perm-empty')).toBeVisible();

    // member can post again
    await expect
      .poll(async () => (await apiCall(testServer.baseURL, owner.token, 'GET', `/api/channels/${general.id}/permissions`)).body.length)
      .toBe(0);
    await memberPage.locator('#msg-input').fill('hello after unblock');
    await memberPage.locator('#msg-input').press('Enter');
    await expect(memberPage.locator('.msg-group', { hasText: 'hello after unblock' })).toBeVisible();

    expect(ownerErrors).toEqual([]);
    expect(memberErrors).toEqual([]);
    await ownerContext.close();
    await memberContext.close();
  } finally {
    await testServer.close();
  }
});

test('non-manager accounts see explicit permission-denied states', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const owner = await registerUser(testServer.baseURL, 'dnown', OWNER_PASSWORD);
    const member = await registerUser(testServer.baseURL, 'dnmem', MEMBER_PASSWORD);

    const guildRes = await apiCall(testServer.baseURL, owner.token, 'POST', '/api/guilds', { name: 'Denied Guild' });
    expect(guildRes.status).toBe(201);
    const guild = guildRes.body;
    const general = guild.channels.find(ch => ch.name === 'general');
    expect(general).toBeTruthy();

    const inviteRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${general.id}/invites`, {});
    expect(inviteRes.status).toBe(201);
    expect((await apiCall(testServer.baseURL, member.token, 'POST', `/api/invites/${inviteRes.body.code}`, {})).status).toBeLessThan(300);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await uiLogin(page, testServer.baseURL, member.email, MEMBER_PASSWORD);
    await page.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await page.locator(`.channel-item[data-ch-id="${general.id}"]`).click();
    await expect(page.locator('#msg-input')).toBeVisible();

    await openServerSettings(page, guild.id);
    await expect(page.locator('#ss-no-perm')).toBeVisible();
    await expect(page.locator('#ss-save-overview')).toHaveCount(0);
    await expect(page.locator('#ss-owner-name')).toBeVisible(); // read-only info still available
    await page.locator('#ss-close').click();
    await expect(page.locator('#server-settings')).toHaveClass(/hidden/);

    // channel settings permissions tab is explicitly denied
    await page.locator(`.channel-item[data-ch-id="${general.id}"]`).click({ button: 'right' });
    await page.locator('#ctx-menu .ctx-item[data-action="ch_edit"]').click();
    const dialog = page.locator('.da-dialog-box.da-dialog-wide');
    await expect(dialog).toBeVisible();
    await dialog.locator('.cs-tab[data-tab="permissions"]').click();
    await expect(dialog.locator('#cs-perm-denied')).toBeVisible();
    await expect(dialog.locator('#cs-add-perm')).toHaveCount(0);

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});
