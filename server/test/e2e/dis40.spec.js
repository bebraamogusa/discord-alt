import { expect, test } from 'playwright/test';
import speakeasy from 'speakeasy';
import { startTestServer } from './serverHarness.js';

function captureErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
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

async function registerViaUi(page, baseURL, name) {
  await page.goto(`${baseURL}/app`);
  await expect(page.locator('#auth-login')).toBeVisible();
  await page.getByRole('button', { name: /зарегистрироваться/i }).click();
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  await page.locator('#reg-email').fill(`${name}-${suffix}@example.test`);
  await page.locator('#reg-name').fill(`${name}${suffix}`.slice(0, 24));
  await page.locator('#reg-pass').fill('dis40-e2e-password');
  await page.locator('#reg-btn').click();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
  await expect(page.locator('.dm-item.friends-btn')).toBeVisible();
}

function totp(secret) {
  return speakeasy.totp({ secret, encoding: 'base32' });
}

async function openSecurityPage(page) {
  await page.locator('#btn-settings').click();
  await expect(page.locator('#user-settings')).toBeVisible();
  await page.locator('#us-nav-items [data-page="security"]').click();
  await expect(page.locator('#mfa-body .settings-section-title, #mfa-disabled-view, #mfa-enabled-view').first()).toBeVisible({ timeout: 10_000 });
}

test('MFA enroll, rejected code, confirm, disable end-to-end', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const context = await browser.newContext();
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await registerViaUi(page, testServer.baseURL, 'mfa');
    await openSecurityPage(page);

    // Disabled state -> enroll
    await expect(page.locator('#mfa-disabled-view')).toBeVisible();
    await page.locator('#mfa-enable-btn').click();
    const secret = await page.locator('#mfa-secret').textContent();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    await expect(page.locator('#mfa-qr')).toBeVisible();

    // Rejected confirmation code keeps enrollment open with an error
    await page.locator('#mfa-confirm-code').fill('000000');
    await page.locator('#mfa-confirm-btn').click();
    await expect(page.locator('#mfa-error')).toBeVisible();
    await expect(page.locator('#mfa-error')).not.toBeEmpty();

    // Correct TOTP confirms and reveals backup codes
    await page.locator('#mfa-confirm-code').fill(totp(secret));
    await page.locator('#mfa-confirm-btn').click();
    await expect(page.locator('#mfa-enabled-view')).toBeVisible();
    await expect(page.locator('#mfa-backup-codes span').first()).toBeVisible();

    // State survives a reload
    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/);
    await openSecurityPage(page);
    await expect(page.locator('#mfa-enabled-view')).toBeVisible();

    // Wrong disable code is rejected
    await page.locator('#mfa-disable-code').fill('000000');
    await page.locator('#mfa-disable-btn').click();
    await expect(page.locator('#mfa-disable-error')).toBeVisible();

    // Correct TOTP disables 2FA
    await page.locator('#mfa-disable-code').fill(totp(secret));
    await page.locator('#mfa-disable-btn').click();
    await expect(page.locator('#mfa-disabled-view')).toBeVisible();

    // The two deliberate wrong-code attempts surface as browser 400 resource logs;
    // anything else is a real defect.
    const unexpected = errors.filter(e => !/status of 400/.test(e));
    expect(unexpected).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});

test('group DM create via multi-select, messaging, leave', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    await pointClientAtTestServer(contextA, testServer.baseURL);
    await pointClientAtTestServer(contextB, testServer.baseURL);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = captureErrors(pageA);
    const errorsB = captureErrors(pageB);

    await registerViaUi(pageA, testServer.baseURL, 'gamma');
    await registerViaUi(pageB, testServer.baseURL, 'delta');
    const userB = await pageB.evaluate(() => ({ id: window.S.me.id, username: window.S.me.username }));

    // Multi-select B in the new-DM modal and create the group
    await pageA.locator('#btn-new-dm').click();
    await expect(pageA.locator('#dm-group-create')).toBeDisabled();
    await pageA.locator('#dm-search-input').fill(userB.username);
    const resultItem = pageA.locator('.dm-search-item', { hasText: userB.username });
    await expect(resultItem).toBeVisible({ timeout: 10_000 });
    await resultItem.locator('.dm-pick-checkbox').check();
    await expect(pageA.locator('#dm-group-create')).toBeEnabled();
    await pageA.locator('#dm-group-create').click();

    await expect(pageA.locator('#chat-ch-name')).toHaveText(userB.username, { timeout: 10_000 });
    await expect(pageA.locator('#chat-ch-topic')).toContainText('2');
    const groupId = await pageA.evaluate(() => window.S.activeChannelId);

    // Message between both accounts in realtime
    await pageA.locator('#msg-input').fill('hello group');
    await pageA.locator('#msg-input').press('Enter');

    const groupItemB = pageB.locator(`.dm-item[data-ch-id="${groupId}"]`);
    await expect(groupItemB).toBeVisible({ timeout: 10_000 });
    await groupItemB.click();
    await expect(pageB.locator('#msg-input')).toBeVisible();
    await expect(pageB.locator('.msg-group', { hasText: 'hello group' })).toBeVisible({ timeout: 10_000 });

    await pageB.locator('#msg-input').fill('hi from delta');
    await pageB.locator('#msg-input').press('Enter');
    await expect(pageA.locator('.msg-group', { hasText: 'hi from delta' })).toBeVisible({ timeout: 10_000 });

    // A leaves the group via the context menu
    await pageA.locator(`.dm-item[data-ch-id="${groupId}"]`).click({ button: 'right' });
    await expect(pageA.locator('#ctx-menu')).toBeVisible();
    await pageA.locator('[data-action="dm_leave_group"]').click();
    await expect(pageA.locator(`.dm-item[data-ch-id="${groupId}"]`)).toHaveCount(0);
    await expect(pageB.locator(`.dm-item[data-ch-id="${groupId}"]`)).toBeVisible();

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);

    await contextA.close();
    await contextB.close();
  } finally {
    await testServer.close();
  }
});

test('guild notification toggle persists and feeds unread gating state', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const context = await browser.newContext();
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await registerViaUi(page, testServer.baseURL, 'notif');
    const guild = await page.evaluate(async () => {
      const response = await fetch('/api/guilds', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${localStorage.getItem('da_token')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Dis40 Guild' }),
      });
      if (!response.ok) throw new Error(`guild create failed: ${response.status}`);
      return response.json();
    });

    await page.reload();
    const serverIcon = page.locator(`.server-icon[data-server-id="${guild.id}"]`);
    await expect(serverIcon).toBeVisible({ timeout: 15_000 });

    // Open notification settings from the server context menu
    await serverIcon.click({ button: 'right' });
    await expect(page.locator('#ctx-menu')).toBeVisible();
    await page.locator('[data-action="srv_notifications"]').click();
    const dialog = page.locator('.da-dialog-box', { has: page.locator('#ns-muted') });
    await expect(dialog).toBeVisible();

    // Toggle mute + mentions-only, save
    await dialog.locator('#ns-muted').check();
    await dialog.locator('#ns-level').selectOption('1');
    await dialog.locator('#ns-save').click();
    await expect(dialog).toHaveCount(0);

    // Saved values land directly in the DIS-39 gating cache
    await expect.poll(() => page.evaluate((id) => window.S.guildSettings[id]?.muted, guild.id), { timeout: 5000 }).toBe(1);
    await expect.poll(() => page.evaluate((id) => window.S.guildSettings[id]?.message_notifications, guild.id), { timeout: 5000 }).toBe(1);

    // Reopening shows persisted values
    await serverIcon.click({ button: 'right' });
    await page.locator('[data-action="srv_notifications"]').click();
    const reopened = page.locator('.da-dialog-box', { has: page.locator('#ns-muted') });
    await expect(reopened).toBeVisible();
    await expect(reopened.locator('#ns-muted')).toBeChecked();
    await expect(reopened.locator('#ns-level')).toHaveValue('1');

    // Server-side persistence too
    const stored = await page.evaluate(async (id) => {
      const response = await fetch(`/api/users/@me/guilds/${id}/settings`, {
        headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` },
      });
      return response.json();
    }, guild.id);
    expect(Number(stored.muted)).toBe(1);
    expect(Number(stored.message_notifications)).toBe(1);

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});
