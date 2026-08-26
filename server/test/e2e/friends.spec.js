import { expect, test } from 'playwright/test';
import { startTestServer } from './serverHarness.js';

function captureErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
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

async function registerViaUi(page, baseURL, name) {
  await page.goto(`${baseURL}/app`);
  await expect(page.locator('#auth-login')).toBeVisible();
  await page.getByRole('button', { name: /зарегистрироваться/i }).click();
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  await page.locator('#reg-email').fill(`fr-${name}-${suffix}@example.test`);
  await page.locator('#reg-name').fill(`${name}${suffix}`.slice(0, 24));
  await page.locator('#reg-pass').fill('fr-e2e-password');
  await page.locator('#reg-btn').click();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
  await expect(page.locator('.dm-item.friends-btn')).toBeVisible();
}

test('two-account friend lifecycle covers add, accept, dm, remove, decline and block', async ({ browser }) => {
  test.setTimeout(90_000);
  const testServer = await startTestServer();
  try {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(contextA, testServer.baseURL);
    await pointClientAtTestServer(contextB, testServer.baseURL);

    // Fail the first relationships fetch so alpha hits the friends error state,
    // then let everything through after the retry.
    let failRelationships = true;
    await contextA.route('**/api/users/@me/relationships*', async route => {
      if (failRelationships && route.request().method() === 'GET') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
        return;
      }
      await route.fallback();
    });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = captureErrors(pageA);
    const errorsB = captureErrors(pageB);

    await registerViaUi(pageA, testServer.baseURL, 'alpha');
    await registerViaUi(pageB, testServer.baseURL, 'beta');
    const userA = await pageA.evaluate(() => ({ id: window.S.me.id, username: window.S.me.username }));
    const userB = await pageB.evaluate(() => ({ id: window.S.me.id, username: window.S.me.username }));

    // ── loading + error + retry ──────────────────────────────────────────
    await pageA.locator('.dm-item.friends-btn').click();
    for (const tabName of ['online', 'all', 'pending', 'blocked', 'add-friend']) {
      await expect(pageA.locator(`.friends-header [data-tab="${tabName}"]`)).toBeVisible();
    }
    await expect(pageA.locator('#friends-error')).toBeVisible();
    failRelationships = false;
    await pageA.locator('#friends-retry').click();
    await expect(pageA.locator('.friends-empty[data-empty-for="online"]')).toBeVisible();

    // ── alpha sends a friend request ─────────────────────────────────────
    await pageA.locator('[data-tab="add-friend"]').click();
    await expect(pageA.locator('#friend-add-input')).toBeVisible();
    await pageA.locator('#friend-add-input').fill(userB.username);
    await pageA.locator('#friend-add-submit').click();
    await pageA.locator('[data-tab="pending"]').click();
    await expect(pageA.locator(`.friend-item[data-user-id="${userB.id}"]`)).toBeVisible();
    await expect(pageA.locator(`.friend-item[data-user-id="${userB.id}"] [data-action="decline"]`)).toBeVisible();

    // ── beta sees the request live and accepts it ────────────────────────
    await expect(pageB.locator('.dm-item.friends-btn .unread-badge')).toHaveText('1');
    await pageB.locator('.dm-item.friends-btn').click();
    await pageB.locator('[data-tab="pending"]').click();
    const rowOnB = pageB.locator(`.friend-item[data-user-id="${userA.id}"]`);
    await expect(rowOnB).toBeVisible();
    await rowOnB.locator('[data-action="accept"]').click();
    await expect(pageB.locator(`.friend-item[data-user-id="${userA.id}"]`)).toHaveCount(0);
    await pageB.locator('[data-tab="all"]').click();
    await expect(pageB.locator(`.friend-item[data-user-id="${userA.id}"] .friend-name`)).toHaveText(userA.username);

    // alpha's pending list empties live and the accepted friend shows up
    await expect(pageA.locator('#friends-body .friend-item')).toHaveCount(0);
    await pageA.locator('[data-tab="all"]').click();
    await expect(pageA.locator(`.friend-item[data-user-id="${userB.id}"]`)).toBeVisible();

    // ── clicking an accepted friend opens/creates a DM ───────────────────
    await pageA.locator(`.friend-item[data-user-id="${userB.id}"]`).click();
    await expect(pageA.locator('#chat-ch-name')).toHaveText(userB.username, { timeout: 10_000 });
    await expect(pageA.locator('#msg-input')).toBeVisible();
    await expect(pageA.locator('#friends-view')).toBeHidden();

    // ── friendship survives reload ───────────────────────────────────────
    await pageA.reload();
    await expect(pageA.locator('#app')).not.toHaveClass(/hidden/);
    await pageA.locator('.dm-item.friends-btn').click();
    await pageA.locator('[data-tab="all"]').click();
    await expect(pageA.locator(`.friend-item[data-user-id="${userB.id}"]`)).toBeVisible();

    // ── removing an accepted friend updates both sides live ──────────────
    await pageA.locator(`.friend-item[data-user-id="${userB.id}"] [data-action="remove"]`).click();
    await expect(pageA.locator('#friends-body .friend-item')).toHaveCount(0);
    await expect(pageB.locator(`.friend-item[data-user-id="${userA.id}"]`)).toHaveCount(0);

    // ── declining an incoming request updates both sides live ────────────
    await pageA.locator('[data-tab="add-friend"]').click();
    await pageA.locator('#friend-add-input').fill(userB.username);
    await pageA.locator('#friend-add-submit').click();
    await pageA.locator('[data-tab="pending"]').click();
    await expect(pageA.locator(`.friend-item[data-user-id="${userB.id}"]`)).toBeVisible();
    await expect(pageB.locator('.dm-item.friends-btn .unread-badge')).toHaveText('1');
    await pageB.locator('[data-tab="pending"]').click();
    await pageB.locator(`.friend-item[data-user-id="${userA.id}"] [data-action="decline"]`).click();
    await expect(pageA.locator('#friends-body .friend-item')).toHaveCount(0);
    await expect(pageB.locator('#friends-body .friend-item')).toHaveCount(0);
    await expect(pageB.locator('.dm-item.friends-btn .unread-badge')).toHaveCount(0);

    // ── blocking from an incoming request and unblocking again ───────────
    await pageA.locator('[data-tab="add-friend"]').click();
    await pageA.locator('#friend-add-input').fill(userB.username);
    await pageA.locator('#friend-add-submit').click();
    await pageB.locator(`.friend-item[data-user-id="${userA.id}"] [data-action="block"]`).click();
    await pageB.locator('[data-tab="blocked"]').click();
    const blockedRow = pageB.locator(`.friend-item[data-user-id="${userA.id}"]`);
    await expect(blockedRow).toBeVisible();
    await expect(pageA.locator('#friends-body .friend-item')).toHaveCount(0);
    await blockedRow.locator('[data-action="unblock"]').click();
    await expect(pageB.locator('#friends-body .friend-item')).toHaveCount(0);

    // ── inaccessible target shows an inline error ────────────────────────
    await pageA.locator('[data-tab="add-friend"]').click();
    await pageA.locator('#friend-add-input').fill(userA.username);
    await pageA.locator('#friend-add-submit').click();
    await expect(pageA.locator('#friend-add-error')).not.toBeEmpty();

    // Intentional failure phases above log browser resource errors; reset
    // before asserting that normal usage produced no errors at all.
    errorsA.length = 0;
    errorsB.length = 0;
    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);

    await contextA.close();
    await contextB.close();
  } finally {
    await testServer.close();
  }
});
