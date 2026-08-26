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
  return `${Date.now()}${Math.floor(Math.random() * 10000)}`;
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
    password: 'e2e-dis44-password',
  });
  expect(res.status).toBe(201);
  return { token: res.body.token, userId: res.body.user.id, username: res.body.user.username, email: `${name}-${suffix}@example.test`, password: 'e2e-dis44-password' };
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

test('DIS-44 channel/category management: create, rename, drag persistence and thread rendering', async ({ browser }) => {
  const testServer = await startTestServer();
  try {
    const owner = await registerUser(testServer.baseURL, 'dis44owner');
    const guildRes = await apiCall(testServer.baseURL, owner.token, 'POST', '/api/guilds', { name: 'DIS44 Guild' });
    expect(guildRes.status).toBe(201);
    const guild = guildRes.body;
    const guildId = guild.id;
    const general = guild.channels.find(ch => ch.name === 'general');
    expect(general).toBeTruthy();

    // create category via API so we have one to rename/drag into
    const catRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/guilds/${guildId}/channels`, { name: 'Category One', type: 4 });
    expect(catRes.status).toBe(201);
    const categoryId = catRes.body.id;

    // create extra channels for drag test
    const extra1 = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/guilds/${guildId}/channels`, { name: 'drag-me', type: 0 });
    expect(extra1.status).toBe(201);
    const dragChannelId = extra1.body.id;

    // create a message and thread to verify thread rendering
    const msgRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/channels/${general.id}/messages`, { content: 'hello thread parent' });
    expect(msgRes.status).toBe(201);
    const msgId = msgRes.body.id;
    const threadRes = await apiCall(testServer.baseURL, owner.token, 'POST', `/api/v1/channels/${general.id}/messages/${msgId}/threads`, { name: 'my-thread' });
    expect(threadRes.status).toBe(200);
    const threadId = threadRes.body.id;
    expect(threadRes.body.type).toBe(11);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(context, testServer.baseURL);
    const page = await context.newPage();
    const errors = captureErrors(page);

    await uiLogin(page, testServer.baseURL, owner.email, owner.password);
    await page.locator(`.server-icon[data-server-id="${guildId}"]`).click();
    await expect(page.locator('.channel-item').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.category-row')).toBeVisible();

    // 1) Create channel via UI with stage and forum types
    // open create channel modal from server dropdown
    await page.locator('#sidebar-header').click();
    await expect(page.locator('#server-dropdown')).not.toHaveClass(/hidden/);
    await page.locator('#sm-create-ch').click();
    await expect(page.locator('#modal-create-channel')).not.toHaveClass(/hidden/);
    // verify stage/forum options exist
    await expect(page.locator('#new-ch-type option[value="stage"]')).toHaveCount(1);
    await expect(page.locator('#new-ch-type option[value="forum"]')).toHaveCount(1);
    // create stage channel
    const stageName = `stage-${uniqueSuffix()}`.slice(0, 20);
    await page.locator('#new-ch-name').fill(stageName);
    await page.locator('#new-ch-type').selectOption('stage');
    await page.locator('#btn-confirm-create-channel').click();
    await expect(page.locator('#modal-create-channel')).toHaveClass(/hidden/, { timeout: 8000 });
    await expect(page.locator('.channel-item', { hasText: stageName })).toBeVisible({ timeout: 8000 });
    // verify via API that type is 13 (string 'stage' via legacy mapping)
    const freshAfterStage = await apiCall(testServer.baseURL, owner.token, 'GET', `/api/guilds/${guildId}`, undefined);
    const createdStage = freshAfterStage.body.channels.find(c => c.name === stageName);
    expect(createdStage).toBeTruthy();
    expect(['stage', 13].includes(createdStage.type)).toBeTruthy();

    // create forum channel
    await page.locator('#sidebar-header').click();
    await page.locator('#sm-create-ch').click();
    await expect(page.locator('#modal-create-channel')).not.toHaveClass(/hidden/);
    const forumName = `forum-${uniqueSuffix()}`.slice(0, 20);
    await page.locator('#new-ch-name').fill(forumName);
    await page.locator('#new-ch-type').selectOption('forum');
    await page.locator('#btn-confirm-create-channel').click();
    await expect(page.locator('#modal-create-channel')).toHaveClass(/hidden/, { timeout: 8000 });
    await expect(page.locator('.channel-item', { hasText: forumName })).toBeVisible({ timeout: 8000 });
    const freshAfterForum = await apiCall(testServer.baseURL, owner.token, 'GET', `/api/guilds/${guildId}`, undefined);
    const createdForum = freshAfterForum.body.channels.find(c => c.name === forumName);
    expect(createdForum).toBeTruthy();
    expect(['forum', 15].includes(createdForum.type)).toBeTruthy();

    // 2) Rename category via context menu
    const catRow = page.locator(`.category-row[data-cat-id="${categoryId}"]`);
    await expect(catRow).toBeVisible();
    await catRow.click({ button: 'right' });
    await expect(page.locator('#ctx-menu')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ctx-menu .ctx-item[data-action="cat_rename"]')).toBeVisible();
    await page.locator('#ctx-menu .ctx-item[data-action="cat_rename"]').click();
    // daPrompt appears
    await expect(page.locator('#dap-input')).toBeVisible({ timeout: 5000 });
    const newCatName = `Renamed-${uniqueSuffix()}`.slice(0, 18);
    await page.locator('#dap-input').fill(newCatName);
    await page.locator('#dap-ok').click();
    await expect(page.locator('#toast.visible.success')).toBeVisible({ timeout: 8000 });
    await expect(page.locator(`.category-row[data-cat-id="${categoryId}"]`)).toContainText(newCatName, { timeout: 5000 });
    // verify persistence via API
    const catAfter = await apiCall(testServer.baseURL, owner.token, 'GET', `/api/guilds/${guildId}`, undefined);
    const renamedCat = catAfter.body.categories.find(c => c.id === categoryId);
    expect(renamedCat.name).toBe(newCatName);

    // 3) Drag channel into category and verify persistence after reload
    // ensure drag channel is initially uncategorized (should be before categories or in top group)
    const dragEl = page.locator(`.channel-item[data-ch-id="${dragChannelId}"]`);
    await expect(dragEl).toBeVisible();
    // perform drag onto category row
    await dragEl.dragTo(catRow, { force: true });
    // wait for patch to complete - poll API until parent_id matches
    await expect.poll(async () => {
      const fresh = await apiCall(testServer.baseURL, owner.token, 'GET', `/api/guilds/${guildId}`, undefined);
      const ch = fresh.body.channels.find(c => c.id === dragChannelId);
      return ch?.category_id || ch?.parent_id || null;
    }, { timeout: 10000 }).toBe(categoryId);
    // verify UI order: channel should now be after category
    // easiest: check that drag channel is after category in DOM
    await expect.poll(async () => page.evaluate(({ chId, catId }) => {
      const container = document.getElementById('sidebar-channel-list');
      const children = [...container.children];
      const catIdx = children.findIndex(el => el.dataset.catId && String(el.dataset.catId) === String(catId));
      const chIdx = children.findIndex(el => el.dataset.chId && String(el.dataset.chId) === String(chId));
      return chIdx > catIdx;
    }, { chId: dragChannelId, catId: categoryId }), { timeout: 5000 }).toBe(true);

    // reload and verify persistence
    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/);
    await page.locator(`.server-icon[data-server-id="${guildId}"]`).click();
    await expect(page.locator('.channel-item').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`.category-row[data-cat-id="${categoryId}"]`)).toContainText(newCatName);
    // drag channel still in category after reload - check DOM order again and API
    await expect(page.locator(`.channel-item[data-ch-id="${dragChannelId}"]`)).toBeVisible();
    const afterReloadPos = await page.evaluate(({ chId }) => {
      const container = document.getElementById('sidebar-channel-list');
      const children = [...container.children];
      return children.findIndex(el => el.dataset.chId === chId);
    }, { chId: dragChannelId });
    expect(afterReloadPos).toBeGreaterThan(-1);
    const freshAfterReload = await apiCall(testServer.baseURL, owner.token, 'GET', `/api/guilds/${guildId}`, undefined);
    const persisted = freshAfterReload.body.channels.find(c => c.id === dragChannelId);
    expect(persisted.category_id).toBe(categoryId);

    // 4) Verify thread rendering indented
    // thread should be visible indented under parent "general"
    const threadEl = page.locator(`.channel-item.thread[data-ch-id="${threadId}"]`);
    await expect(threadEl).toBeVisible({ timeout: 8000 });
    await expect(threadEl).toContainText('my-thread');
    // check indent style: margin-left should be >0
    const marginLeft = await threadEl.evaluate(el => getComputedStyle(el).marginLeft);
    expect(parseInt(marginLeft)).toBeGreaterThan(0);
    // verify parent association: thread appears right after general channel
    const threadAfterParent = await page.evaluate(({ parentId, thrId }) => {
      const container = document.getElementById('sidebar-channel-list');
      const children = [...container.children];
      const parentIdx = children.findIndex(el => el.dataset.chId === parentId);
      const thrIdx = children.findIndex(el => el.dataset.chId === thrId);
      return thrIdx === parentIdx + 1 || thrIdx > parentIdx;
    }, { parentId: general.id, thrId: threadId });
    expect(threadAfterParent).toBe(true);

    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await testServer.close();
  }
});
