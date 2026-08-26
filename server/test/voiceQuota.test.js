import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceLimits } from '../media/mediasoup.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('voice resource quotas remain bounded', () => {
  assert.deepEqual(voiceLimits, {
    transportsPerUser: 4,
    producersPerUser: 4,
    consumersPerUser: 64,
    transportsPerChannel: 200,
    producersPerChannel: 200,
    consumersPerChannel: 1000,
  });
});

test('voice routes retain rate limiting and disconnect cleanup hooks', async () => {
  const route = await readFile(resolve(root, 'routes/voice.js'), 'utf8');
  const socket = await readFile(resolve(root, 'socket.js'), 'utf8');
  assert.match(route, /Voice request rate limit exceeded/);
  assert.match(route, /Voice transport quota exceeded/);
  assert.match(route, /Voice producer quota exceeded/);
  assert.match(route, /Voice consumer quota exceeded/);
  assert.match(socket, /cleanupPeer\(userId\)/);
});
