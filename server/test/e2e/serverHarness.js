import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const serverDir = join(process.cwd());

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(url, process) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`test server exited with ${process.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('test server did not become healthy');
}

export async function startTestServer({ media = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'discord-alt-e2e-'));
  const port = await reservePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['index.core.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: join(root, 'discord-alt.db'),
      UPLOADS_ROOT: join(root, 'uploads'),
      JWT_SECRET: 'e2e-test-jwt-secret-that-is-at-least-32-characters',
      COOKIE_SECURE: 'false',
      DISABLE_MEDIA: media ? undefined : '1',
      DISABLE_CRON: '1',
    },
    stdio: 'pipe',
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    await waitForServer(baseURL, child);
  } catch (error) {
    child.kill();
    await rm(root, { recursive: true, force: true });
    throw new Error(`${error.message}\n${stderr}`);
  }
  return {
    baseURL,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ]);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
