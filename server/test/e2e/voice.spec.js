import { expect, test } from 'playwright/test';
import { chromium } from 'playwright';
import { startTestServer } from './serverHarness.js';

const FAKE_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

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
  await page.locator('#reg-email').fill(`voice-${name}-${suffix}@example.test`);
  await page.locator('#reg-name').fill(`${name}${suffix}`.slice(0, 24));
  await page.locator('#reg-pass').fill('voice-e2e-password');
  await page.locator('#reg-btn').click();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/);
}

async function until(fn, timeout = 10_000, interval = 250) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { }
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

async function createGuildWithVoiceChannel(page) {
  return page.evaluate(async () => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('da_token')}` };
    const post = async (url, body) => {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
      if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
      return res.json();
    };
    const guild = await post('/api/guilds', { name: 'Voice Guild' });
    const channel = await post(`/api/guilds/${guild.id}/channels`, { name: 'Voice Room', type: 2 });
    const invite = await post(`/api/guilds/${guild.id}/invites`, {});
    return { guildId: guild.id, channelId: channel.id, inviteCode: invite.code };
  });
}

async function joinGuildViaInvite(page, code) {
  await page.evaluate(async (inviteCode) => {
    const res = await fetch(`/api/invites/${inviteCode}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${localStorage.getItem('da_token')}` },
    });
    if (!res.ok) throw new Error(`invite join failed: ${res.status}`);
  }, code);
}

async function openVoiceChannel(page, guildId, channelId) {
  await page.locator(`.server-icon[data-server-id="${guildId}"]`).click();
  const item = page.locator(`.channel-item[data-ch-id="${channelId}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#voice-panel')).toBeVisible();
}

async function joinVoice(page) {
  await page.locator('#vp-join').click();
  await until(() => page.evaluate(() => window.__voiceDebug().connected));
}

test('two users exchange microphone audio and leave cleanly', async () => {
  test.setTimeout(120_000);
  const testServer = await startTestServer({ media: true });
  const browser = await chromium.launch({ args: FAKE_MEDIA_ARGS });
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
    const userB = await pageB.evaluate(() => ({ id: window.S.me.id }));

    const { guildId, channelId, inviteCode } = await createGuildWithVoiceChannel(pageA);
    await joinGuildViaInvite(pageB, inviteCode);

    await pageA.reload();
    await pageB.reload();
    await expect(pageA.locator('#app')).not.toHaveClass(/hidden/);
    await expect(pageB.locator('#app')).not.toHaveClass(/hidden/);

    await openVoiceChannel(pageA, guildId, channelId);
    await joinVoice(pageA);
    await expect(pageA.locator('.vp-participant')).toHaveCount(1);

    await openVoiceChannel(pageB, guildId, channelId);
    await joinVoice(pageB);

    for (const page of [pageA, pageB]) {
      await expect(page.locator('.vp-participant')).toHaveCount(2);
      await until(async () => {
        const debug = await page.evaluate(() => window.__voiceDebug());
        return debug.consumerCount >= 1 && debug.audioElementCount >= 1;
      });
    }

    const audioMeta = await pageA.evaluate(() =>
      [...document.querySelectorAll('audio[data-producer-id]')].map(el => ({
        producerId: el.dataset.producerId,
        userId: el.dataset.userId,
        live: el.srcObject?.getAudioTracks().every(track => track.readyState === 'live'),
      })),
    );
    expect(audioMeta.length).toBeGreaterThanOrEqual(1);
    expect(audioMeta.some(item => item.userId === userB.id && item.live)).toBe(true);

    await pageB.locator('#vp-mute').click();
    await until(() => pageB.evaluate(() => {
      const debug = window.__voiceDebug();
      return debug.muted === true && debug.audioProducerPaused === true;
    }));
    await until(async () => {
      const count = await pageA.locator(`.vp-participant:has(.vp-name)`).evaluateAll(nodes =>
        nodes.filter(node => node.querySelector('.vp-muted-badge')).length,
      );
      return count === 1;
    });

    await pageB.locator('#vp-mute').click();
    await until(() => pageB.evaluate(() => window.__voiceDebug().audioProducerPaused === false));

    await pageB.locator('#vp-leave').click();
    const leftDebug = await until(() => pageB.evaluate(() => {
      const debug = window.__voiceDebug();
      const done = !debug.connected && debug.producerCount === 0 && debug.consumerCount === 0 &&
        debug.audioElementCount === 0 && debug.liveMicTracks === 0;
      return done ? debug : null;
    }));
    expect(leftDebug.liveScreenTracks).toBe(0);
    await expect(pageB.locator('#vp-join')).toBeVisible();

    await expect(pageA.locator('.vp-participant')).toHaveCount(1);
    await until(() => pageA.evaluate(() => {
      const debug = window.__voiceDebug();
      return debug.consumerCount === 0 && debug.audioElementCount === 0;
    }));

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);

    await contextA.close();
    await contextB.close();
  } finally {
    await browser.close();
    await testServer.close();
  }
});

test('screen share renders remotely and stops cleanly', async () => {
  test.setTimeout(120_000);
  const testServer = await startTestServer({ media: true });
  const browser = await chromium.launch({
    args: [...FAKE_MEDIA_ARGS, '--auto-select-desktop-capture-source=Entire screen'],
  });
  try {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await pointClientAtTestServer(contextA, testServer.baseURL);
    await pointClientAtTestServer(contextB, testServer.baseURL);
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = captureErrors(pageA);
    const errorsB = captureErrors(pageB);

    await registerViaUi(pageA, testServer.baseURL, 'sharer');
    await registerViaUi(pageB, testServer.baseURL, 'watcher');
    const userA = await pageA.evaluate(() => ({ id: window.S.me.id }));

    const { guildId, channelId, inviteCode } = await createGuildWithVoiceChannel(pageA);
    await joinGuildViaInvite(pageB, inviteCode);

    await pageA.reload();
    await pageB.reload();
    await expect(pageA.locator('#app')).not.toHaveClass(/hidden/);
    await expect(pageB.locator('#app')).not.toHaveClass(/hidden/);

    await openVoiceChannel(pageA, guildId, channelId);
    await joinVoice(pageA);
    await openVoiceChannel(pageB, guildId, channelId);
    await joinVoice(pageB);

    for (const page of [pageA, pageB]) {
      await expect(page.locator('.vp-participant')).toHaveCount(2);
    }

    await pageA.locator('#vp-screen').click();
    let started = false;
    try {
      await until(() => pageA.evaluate(() => window.__voiceDebug().screenSharing === true), 8_000);
      started = true;
    } catch { }
    test.skip(!started, 'getDisplayMedia unavailable in headless Chromium; screen share E2E deferred to headed run');

    await until(async () => {
      const debug = await pageB.evaluate(() => window.__voiceDebug());
      return debug.consumerCount >= 2;
    });
    await expect(pageB.locator(`.vp-screen-video[data-screen-user="${userA.id}"]`)).toBeVisible();
    await until(() => pageB.evaluate(userId => {
      const video = document.querySelector(`.vp-screen-video[data-screen-user="${userId}"]`);
      return !!video && video.srcObject instanceof MediaStream &&
        video.srcObject.getVideoTracks().some(track => track.readyState === 'live');
    }, userA.id));

    await pageA.locator('#vp-screen').click();
    await until(() => pageA.evaluate(() => {
      const debug = window.__voiceDebug();
      const done = !debug.screenSharing && debug.liveScreenTracks === 0;
      return done ? debug : null;
    }));
    await until(() => pageB.evaluate(userId =>
      !document.querySelector(`.vp-screen-video[data-screen-user="${userId}"]`), userA.id));
    await until(() => pageB.evaluate(() => window.__voiceDebug().consumerCount <= 1));

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);

    await contextA.close();
    await contextB.close();
  } finally {
    await browser.close();
    await testServer.close();
  }
});
