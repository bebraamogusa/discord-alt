import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function readRoot(name) {
  return readFile(resolve(root, name), 'utf8');
}

test('Docker image uses locked production dependencies and no runtime data', async () => {
  const dockerfile = await readRoot('Dockerfile');
  const dockerignore = await readRoot('.dockerignore');

  assert.match(dockerfile, /COPY server\/package\.json server\/package-lock\.json \.\//);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /chown -R node:node \/app\/server \/app\/client \/app\/data \/app\/uploads/);
  assert.match(dockerignore, /server\/test\/\*\*/);
  assert.match(dockerignore, /server\/data\/\*\*/);
  assert.match(dockerignore, /\*\*\/\.npm$/m);
  assert.match(dockerignore, /\*\*\/node_modules$/m);
});

test('compose runs with writable persistent mounts and keeps healthcheck', async () => {
  const compose = await readRoot('docker-compose.yml');

  assert.match(compose, /user: ["']1000:1000["']/);
  assert.match(compose, /\.\/uploads:\/app\/uploads:rw/);
  assert.match(compose, /\.\/data:\/app\/data:rw/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health'\)/);
});

test('nginx keeps HTTPS security headers compatible with realtime clients', async () => {
  const nginx = await readRoot('nginx/nginx.conf.template');
  assert.match(nginx, /listen 80;[\s\S]*return 301 https:\/\//);
  assert.match(nginx, /listen 443 ssl;[\s\S]*add_header Strict-Transport-Security "max-age=31536000" always;/);
  assert.match(nginx, /add_header Content-Security-Policy[\s\S]*script-src 'self' https:\/\/cdn\.socket\.io/);
  assert.match(nginx, /connect-src 'self' https: ws: wss:/);
  assert.match(nginx, /media-src 'self' blob:/);
  assert.match(nginx, /add_header X-Frame-Options "DENY" always;/);
  assert.match(nginx, /add_header Referrer-Policy "strict-origin-when-cross-origin" always;/);
  assert.match(nginx, /add_header X-Content-Type-Options "nosniff" always;/);
  assert.match(nginx, /location \/socket\.io\/[\s\S]*proxy_set_header Upgrade \$http_upgrade;/);
});
