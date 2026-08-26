import { expect, test } from 'playwright/test';
import { startTestServer } from './serverHarness.js';

function captureErrors(page, ignored = []) {
  const errors = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (ignored.some(p => text.includes(p))) return;
    errors.push(`console: ${text}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  return errors;
}

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

async function openServerSettings(page, guildId) {
  await page.locator(`.server-icon[data-server-id="${guildId}"]`).click({ button: 'right' });
  await page.locator('#ctx-menu .ctx-item[data-action="srv_settings"]').click();
  await expect(page.locator('#server-settings')).not.toHaveClass(/hidden/);
}

async function bootWithToken(page, baseURL, token) {
  await page.goto(`${baseURL}/app`);
  await page.evaluate(t => localStorage.setItem('da_token', t), token);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
}

test('webhooks CRUD via server settings and permission gating', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const owner = await registerUser(testServer.baseURL, 'whowner', 'e2e-wh-pass');
    const member = await registerUser(testServer.baseURL, 'whmem', 'e2e-wh-pass2');

    const guildRes = await apiCall(testServer.baseURL, owner.token, 'POST', '/api/guilds', { name: 'Webhook Guild' });
    expect(guildRes.status).toBe(201);
    const guild = guildRes.body;
    const general = guild.channels.find(ch => ch.name === 'general');
    expect(general).toBeTruthy();

    const inviteRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${general.id}/invites`, {});
    expect(inviteRes.status).toBe(201);
    expect((await apiCall(testServer.baseURL, member.token, 'POST', `/api/invites/${inviteRes.body.code}`, {})).status).toBeLessThan(300);

    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(ownerContext, testServer.baseURL);
    const page = await ownerContext.newPage();
    const errors = captureErrors(page);

    await uiLogin(page, testServer.baseURL, owner.email, owner.password);
    await page.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await expect(page.locator('.channel-item').first()).toBeVisible();
    await openServerSettings(page, guild.id);

    // webhooks nav present for owner
    await expect(page.locator('[data-ss-page="webhooks"]')).toBeVisible();
    await page.locator('[data-ss-page="webhooks"]').click();
    await expect(page.locator('#wh-create')).toBeVisible();
    await expect(page.locator('#ss-page-title')).toContainText('Webhooks');

    // create webhook via UI
    await page.locator('#wh-create').click();
    await expect(page.locator('#whd-name')).toBeVisible();
    await page.locator('#whd-name').fill('e2e-hook');
    await page.locator('#whd-save').click();
    await page.waitForTimeout(800);
    if (await page.locator('#whd-error').isVisible().catch(() => false)) {
      const txt = await page.locator('#whd-error').textContent();
      throw new Error(`webhook create dialog error: ${txt} | html=${await page.locator('.da-dialog-box').first().innerHTML().catch(() => 'no html')}`);
    }
    await expect(page.locator('#toast.visible.success')).toContainText('created', { timeout: 10000 });
    const row = page.locator('#webhooks-table tr', { hasText: 'e2e-hook' });
    await expect(row).toBeVisible();

    // edit webhook
    await row.locator('.edit-wh-btn').click();
    await expect(page.locator('#whd-name')).toBeVisible();
    // clear and fill
    await page.locator('#whd-name').fill('');
    await page.locator('#whd-name').fill('e2e-hook-renamed');
    await page.locator('#whd-save').click();
    await expect(page.locator('#toast.visible.success')).toContainText('updated');
    await expect(page.locator('#webhooks-table tr', { hasText: 'e2e-hook-renamed' })).toBeVisible();

    // regenerate token (just checks success toast, token rotates server-side)
    const hookRow = page.locator('#webhooks-table tr', { hasText: 'e2e-hook-renamed' });
    await expect(hookRow).toBeVisible();
    const hookId = await hookRow.getAttribute('data-webhook-id');
    expect(hookId).toBeTruthy();
    const beforeToken = await page.evaluate(async (id) => {
      const res = await fetch(`/api/webhooks/${id}`, { headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` } });
      const data = await res.json();
      return data.url;
    }, hookId);
    await page.locator('#webhooks-table tr', { hasText: 'e2e-hook-renamed' }).locator('.regen-wh-btn').click();
    await expect(page.locator('#toast.visible.success')).toContainText('Token');
    const afterToken = await page.evaluate(async (id) => {
      const res = await fetch(`/api/webhooks/${id}`, { headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` } });
      const data = await res.json();
      return data.url;
    }, hookId);
    expect(beforeToken).not.toBe(afterToken);

    // copy webhook URL (clipboard write is best-effort, ensure no error toast)
    await page.locator('#webhooks-table tr', { hasText: 'e2e-hook-renamed' }).locator('.copy-wh-btn').click();
    await expect(page.locator('#toast.visible.success')).toContainText('Copied');

    // delete webhook
    await page.locator('#webhooks-table tr', { hasText: 'e2e-hook-renamed' }).locator('.del-wh-btn').click();
    await expect(page.locator('.da-dialog-box')).toBeVisible();
    await page.locator('#dac-ok').click();
    await expect(page.locator('#toast.visible.success')).toContainText('deleted');
    await expect(page.locator('#webhooks-table tr', { hasText: 'e2e-hook-renamed' })).toHaveCount(0);

    // permission gating for non-manager: webhooks nav hidden and API 403
    const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(memberContext, testServer.baseURL);
    const memberPage = await memberContext.newPage();
    const memberErrors = captureErrors(memberPage, ['status of 403', 'Failed to load resource: the server responded with a status of 403']);
    await uiLogin(memberPage, testServer.baseURL, member.email, member.password);
    await memberPage.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await expect(memberPage.locator('.channel-item').first()).toBeVisible();
    await openServerSettings(memberPage, guild.id);
    await expect(memberPage.locator('[data-ss-page="webhooks"]')).toHaveCount(0);
    await expect(memberPage.locator('[data-ss-page="emoji"]')).toHaveCount(0);
    // API gating check via JS
    const blocked = await memberPage.evaluate(async (guildId) => {
      const res = await fetch(`/api/guilds/${guildId}/webhooks`, { headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` } });
      return res.status;
    }, guild.id);
    expect(blocked).toBe(403);
    expect(memberErrors).toEqual([]);
    await memberContext.close();

    expect(errors).toEqual([]);
    await ownerContext.close();
  } finally {
    await testServer.close();
  }
});

test('events CRUD via server settings with MANAGE_EVENTS gate and i18n', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const owner = await registerUser(testServer.baseURL, 'evowner', 'e2e-ev-pass');
    const member = await registerUser(testServer.baseURL, 'evmem', 'e2e-ev-pass2');

    const guildRes = await apiCall(testServer.baseURL, owner.token, 'POST', '/api/guilds', { name: 'Event Guild' });
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

    await uiLogin(page, testServer.baseURL, owner.email, owner.password);
    await page.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await expect(page.locator('.channel-item').first()).toBeVisible();
    await openServerSettings(page, guild.id);

    await expect(page.locator('[data-ss-page="events"]')).toBeVisible();
    await page.locator('[data-ss-page="events"]').click();
    await expect(page.locator('#ss-page-title')).toContainText('Events');
    await expect(page.locator('#ev-create')).toBeVisible();
    await expect(page.locator('#ss-page-body .empty-text')).toContainText('No events');

    // create external event via UI (no channel, location required)
    await page.locator('#ev-create').click();
    await expect(page.locator('#evd-name')).toBeVisible();
    await page.locator('#evd-name').fill('e2e-event');
    await page.locator('#evd-desc').fill('desc');
    // leave default future time (+1h)
    await page.locator('#evd-location').fill('park');
    await page.locator('#evd-save').click();
    await expect(page.locator('#toast.visible.success')).toContainText('created');
    const row = page.locator('#events-table tr', { hasText: 'e2e-event' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('park');

    // edit event
    await row.locator('.edit-ev-btn').click();
    await expect(page.locator('#evd-name')).toBeVisible();
    await page.locator('#evd-name').fill('');
    await page.locator('#evd-name').fill('e2e-event-renamed');
    await page.locator('#evd-save').click();
    await expect(page.locator('#toast.visible.success')).toContainText('updated');
    await expect(page.locator('#events-table tr', { hasText: 'e2e-event-renamed' })).toBeVisible({ timeout: 10000 });

    // validation: try create with past time should show error
    await page.locator('#ev-create').click();
    await expect(page.locator('#evd-name')).toBeVisible();
    await page.locator('#evd-name').fill('bad-event');
    await page.locator('#evd-start').fill('2000-01-01T00:00');
    await page.locator('#evd-location').fill('nowhere');
    await page.locator('#evd-save').click();
    await expect(page.locator('#evd-error')).toBeVisible();
    await expect(page.locator('#evd-error')).toContainText('future');
    await page.locator('#evd-cancel').click();

    // delete event
    await page.locator('#events-table tr', { hasText: 'e2e-event-renamed' }).locator('.del-ev-btn').click();
    await expect(page.locator('.da-dialog-box')).toBeVisible();
    // daConfirm uses #dac-ok
    await page.locator('#dac-ok').click();
    await expect(page.locator('#toast.visible.success')).toContainText('deleted');
    await expect(page.locator('#events-table tr', { hasText: 'e2e-event-renamed' })).toHaveCount(0);
    await expect(page.locator('#ss-page-body .empty-text')).toContainText('No events');

    // API persistence check
    const remaining = await page.evaluate(async (guildId) => {
      const res = await fetch(`/api/guilds/${guildId}/scheduled-events`, { headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` } });
      return res.json();
    }, guild.id);
    expect(remaining.length).toBe(0);

    // language switch keeps events title translated (check i18n keys exist for ru)
    await page.locator('#ss-close').click();
    await page.locator('#btn-settings').click();
    await page.locator('[data-page="language"]').click();
    await page.locator('.lang-option[data-lang="ru"]').click();
    await expect(page.locator('#user-settings')).toBeVisible();
    // reopen server settings and check translated title
    await page.locator('#us-close').click();
    await openServerSettings(page, guild.id);
    await page.locator('[data-ss-page="events"]').click();
    await expect(page.locator('#ss-page-title')).toContainText('Мероприятия');
    await expect(page.locator('#ev-create')).toContainText('Создать');

    expect(errors).toEqual([]);
    await context.close();

    // non-manager cannot see events page
    const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(memberContext, testServer.baseURL);
    const memberPage = await memberContext.newPage();
    const memberErrors = captureErrors(memberPage, ['status of 403', 'Failed to load resource: the server responded with a status of 403']);
    await uiLogin(memberPage, testServer.baseURL, member.email, member.password);
    await memberPage.locator(`.server-icon[data-server-id="${guild.id}"]`).click();
    await expect(memberPage.locator('.channel-item').first()).toBeVisible();
    await openServerSettings(memberPage, guild.id);
    await expect(memberPage.locator('[data-ss-page="events"]')).toHaveCount(0);
    await expect(memberPage.locator('[data-ss-page="webhooks"]')).toHaveCount(0);
    const evBlocked = await memberPage.evaluate(async (guildId) => {
      const res = await fetch(`/api/guilds/${guildId}/scheduled-events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${localStorage.getItem('da_token')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'shouldfail', entity_type: 3, scheduled_start_time: Math.floor(Date.now()/1000)+3600, entity_metadata: JSON.stringify({ location: 'x' }) })
      });
      return res.status;
    }, guild.id);
    expect(evBlocked).toBe(403);
    expect(memberErrors).toEqual([]);
    await memberContext.close();
  } finally {
    await testServer.close();
  }
});
