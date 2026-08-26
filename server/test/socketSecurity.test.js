import { createServer } from 'http';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { buildSocketServer } from '../socket.js';
import { createTestDb, seedUser, seedGuild, seedChannel, seedMember, makeToken } from './helpers.js';

const JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars-long!!';
const CONNECT_PERMISSION = 1n << 20n;

function waitForEvent(socket, event, timeout = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

function assertNoEvent(socket, event, duration = 150) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, duration);
    function onEvent(payload) {
      clearTimeout(timer);
      reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
    }
    socket.once(event, onEvent);
  });
}

describe('socket signaling security', () => {
  let db;
  let httpServer;
  let baseUrl;
  let alice;
  let bob;
  let channelOne;
  let channelTwo;
  let otherGuildChannel;
  const sockets = [];
  const connections = new Set();

  before(async () => {
    db = createTestDb();
    alice = seedUser(db, { id: 'signal-alice', username: 'signal-alice' });
    bob = seedUser(db, { id: 'signal-bob', username: 'signal-bob' });
    const other = seedUser(db, { id: 'signal-other', username: 'signal-other' });

    const firstGuild = seedGuild(db, alice.id, { id: 'signal-guild-one' });
    seedMember(db, firstGuild.guild.id, bob.id);
    channelOne = seedChannel(db, firstGuild.guild.id, { id: 'signal-channel-one', type: 2 });
    channelTwo = seedChannel(db, firstGuild.guild.id, { id: 'signal-channel-two', type: 2 });
    const secondGuild = seedGuild(db, other.id, { id: 'signal-guild-two' });
    otherGuildChannel = seedChannel(db, secondGuild.guild.id, { id: 'signal-channel-other', type: 2 });

    db.prepare('UPDATE roles SET permissions = ?').run(CONNECT_PERMISSION.toString());
    seedMember(db, secondGuild.guild.id, bob.id);

    httpServer = createServer();
    httpServer.on('connection', (connection) => {
      connections.add(connection);
      connection.on('close', () => connections.delete(connection));
    });
    buildSocketServer(httpServer, {
      db,
      config: { corsOrigin: true, jwtSecret: JWT_SECRET },
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const connection of connections) connection.destroy();
    if (httpServer.closeAllConnections) httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
    db.close();
  });

  async function gateway(user) {
    const socket = connect(`${baseUrl}/gateway`, { transports: ['websocket'] });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.emit('IDENTIFY', { token: makeToken(user.id, user.username) });
    await waitForEvent(socket, 'READY');
    return socket;
  }

  async function join(socket, channelId) {
    socket.emit('VOICE_JOIN', { channel_id: channelId });
    await waitForEvent(socket, 'VOICE_READY');
  }

  it('delivers signaling only between active peers in the same voice channel', async () => {
    const sender = await gateway(alice);
    const recipient = await gateway(bob);
    await join(sender, channelOne.id);
    await join(recipient, channelOne.id);

    const received = waitForEvent(recipient, 'WEBRTC_OFFER');
    sender.emit('WEBRTC_OFFER', {
      to_user_id: bob.id,
      offer: { type: 'offer', sdp: 'valid-sdp' },
    });
    assert.deepEqual(await received, {
      from_user_id: alice.id,
      offer: { type: 'offer', sdp: 'valid-sdp' },
    });
  });

  it('does not deliver cross-channel, cross-guild, or unsolicited signaling', async () => {
    const sender = await gateway(alice);
    const crossChannel = await gateway(bob);
    const crossGuildUser = seedUser(db, { id: 'signal-cross-guild', username: 'signal-cross-guild' });
    seedMember(db, 'signal-guild-two', crossGuildUser.id);
    const crossGuild = await gateway(crossGuildUser);

    await join(sender, channelOne.id);
    await join(crossChannel, channelTwo.id);
    await join(crossGuild, otherGuildChannel.id);

    const noCrossChannel = assertNoEvent(crossChannel, 'WEBRTC_ANSWER');
    const noCrossGuild = assertNoEvent(crossGuild, 'WEBRTC_ICE');
    sender.emit('WEBRTC_ANSWER', { to_user_id: bob.id, answer: { type: 'answer', sdp: 'wrong-channel' } });
    sender.emit('WEBRTC_ICE', { to_user_id: crossGuildUser.id, candidate: { candidate: 'wrong-guild' } });
    sender.emit('WEBRTC_OFFER', { to_user_id: 'signal-no-session', offer: { type: 'offer', sdp: 'unsolicited' } });

    await Promise.all([noCrossChannel, noCrossGuild]);
  });

  it('rejects malformed and oversized signaling without forwarding', async () => {
    const sender = await gateway(alice);
    const recipient = await gateway(bob);
    await join(sender, channelOne.id);
    await join(recipient, channelOne.id);

    const noOffer = assertNoEvent(recipient, 'WEBRTC_OFFER');
    sender.emit('WEBRTC_OFFER', null);
    sender.emit('WEBRTC_OFFER', { to_user_id: bob.id, offer: [] });
    sender.emit('WEBRTC_OFFER', { to_user_id: bob.id, offer: { sdp: 'x'.repeat(256 * 1024) } });
    await noOffer;
  });

  it('persists and broadcasts a gateway status update', async () => {
    const socket = await gateway(alice);
    const presence = waitForEvent(socket, 'PRESENCE_UPDATE');
    socket.emit('UPDATE_STATUS', { status: 'idle', custom_status: 'Away' });

    assert.deepEqual(await presence, {
      user_id: alice.id,
      status: 'idle',
      custom_status: 'Away',
    });
    assert.deepEqual(
      db.prepare('SELECT status, custom_status_text FROM users WHERE id = ?').get(alice.id),
      { status: 'idle', custom_status_text: 'Away' }
    );
  });
});
