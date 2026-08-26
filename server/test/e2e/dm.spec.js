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
  await page.locator('#reg-email').fill(`dm-${name}-${suffix}@example.test`);
  await page.locator('#reg-name').fill(`${name}${suffix}`.slice(0, 24));
  await page.locator('#reg-pass').fill('dm-e2e-password');
  await page.locator('#reg-btn').click();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
  await expect(page.locator('.dm-item.friends-btn')).toBeVisible();
}

test('two participants exchange direct messages in realtime', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(contextA, testServer.baseURL);
    await pointClientAtTestServer(contextB, testServer.baseURL);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = captureErrors(pageA);
    const errorsB = captureErrors(pageB);

    await registerViaUi(pageA, testServer.baseURL, 'alpha');
    await registerViaUi(pageB, testServer.baseURL, 'beta');

    const userB = await pageB.evaluate(() => ({ id: window.S.me.id, username: window.S.me.username }));

    const dm = await pageA.evaluate(async (userId) => {
      const response = await fetch(`/api/users/${userId}/dm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` },
      });
      if (!response.ok) throw new Error(`dm create failed: ${response.status}`);
      return response.json();
    }, userB.id);
    expect(dm.recipient?.id || dm.recipient_id).toBe(userB.id);

    for (const page of [pageA, pageB]) {
      await expect(page.locator(`.dm-item[data-ch-id="${dm.id}"]`)).toBeVisible();
    }

    await pageA.locator(`.dm-item[data-ch-id="${dm.id}"]`).click();
    await expect(pageA.locator('#chat-ch-name')).toHaveText(userB.username);
    await expect(pageA.locator('#msg-input')).toBeVisible();

    await pageB.locator(`.dm-item[data-ch-id="${dm.id}"]`).click();
    await expect(pageB.locator('#msg-input')).toBeVisible();

    await pageA.locator('#msg-input').fill('hello from alpha');
    await pageA.locator('#msg-input').press('Enter');
    await expect(pageB.locator('.msg-group', { hasText: 'hello from alpha' })).toBeVisible({ timeout: 10_000 });

    await pageB.locator('#msg-input').fill('reply from beta');
    await pageB.locator('#msg-input').press('Enter');
    await expect(pageA.locator('.msg-group', { hasText: 'reply from beta' })).toBeVisible({ timeout: 10_000 });

    await pageA.reload();
    await expect(pageA.locator('#app')).not.toHaveClass(/hidden/);
    await pageA.locator(`.dm-item[data-ch-id="${dm.id}"]`).click();
    await expect(pageA.locator('.msg-group', { hasText: 'hello from alpha' })).toBeVisible();

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);

    await contextA.close();
    await contextB.close();
  } finally {
    await testServer.close();
  }
});
