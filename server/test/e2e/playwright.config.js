import { defineConfig } from 'playwright/test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const E2E_PORT = process.env.E2E_PORT || 47631;

export default defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  globalSetup: resolve(__dirname, 'global-setup.js'),
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    headless: true,
  },
  webServer: {
    command: 'node index.core.js',
    cwd: resolve(__dirname, '..', '..'),
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(E2E_PORT),
      JWT_SECRET: 'e2e-local-test-jwt-secret-value-32-chars-min!!',
      DB_PATH: './data/e2e-test.db',
      UPLOADS_ROOT: './data/e2e-uploads',
      DISABLE_MEDIA: '1',
      DISABLE_CRON: '1',
    },
  },
});
