import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.js');
const HELPER_SCRIPT = join(__dirname, '_config_test_helper.mjs');

function runConfigWithEnv(env = {}) {
  try {
    const result = execFileSync(process.execPath, [HELPER_SCRIPT], {
      cwd: join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: env.NODE_ENV || '',
        JWT_SECRET: env.JWT_SECRET || '',
        CORS_ORIGIN: env.CORS_ORIGIN || '',
        MAX_FILE_SIZE: env.MAX_FILE_SIZE || '',
        TRUST_PROXY: env.TRUST_PROXY || '',
      },
      timeout: 10000,
      encoding: 'utf8',
    });
    return { ok: true, output: result.trim() };
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    const combined = stderr + stdout;
    const match = combined.match(/ERROR:(.*)/);
    return { ok: false, error: match ? match[1].trim() : combined.trim() };
  }
}

describe('configSecurity', () => {
  it('missing JWT_SECRET fails', () => {
    const result = runConfigWithEnv({ JWT_SECRET: '' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Missing required env'));
  });

  it('short JWT_SECRET fails', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'short' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('JWT_SECRET must be at least 32 characters'));
  });

  it('known placeholder JWT_SECRET fails', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'change_this_to_a_long_random_secret_at_least_32_chars' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('JWT_SECRET must not be a placeholder'));
  });

  it('valid JWT_SECRET loads config', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'test-config-secret-that-is-explicitly-non-placeholder' });
    assert.equal(result.ok, true);
    const config = JSON.parse(result.output);
    assert.equal(config.jwtSecret, 'test-config-secret-that-is-explicitly-non-placeholder');
  });

  it('production CORS without explicit origin is restrictive', () => {
    const result = runConfigWithEnv({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(32) });
    assert.equal(result.ok, true);
    const config = JSON.parse(result.output);
    assert.deepStrictEqual(config.corsOrigin, []);
  });

  it('explicit CORS_ORIGIN is used', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'a'.repeat(32), CORS_ORIGIN: 'https://example.com, https://other.com' });
    assert.equal(result.ok, true);
    const config = JSON.parse(result.output);
    assert.deepStrictEqual(config.corsOrigin, ['https://example.com', 'https://other.com']);
  });

  it('development mode CORS allows all', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'a'.repeat(32) });
    assert.equal(result.ok, true);
    const config = JSON.parse(result.output);
    assert.equal(config.corsOrigin, true);
  });

  it('default port is 3000', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'a'.repeat(32) });
    assert.equal(result.ok, true);
    const config = JSON.parse(result.output);
    assert.equal(config.port, 3000);
  });

  it('uses configured maximum file size', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'a'.repeat(32), MAX_FILE_SIZE: '4096' });
    assert.equal(result.ok, true);
    const config = JSON.parse(result.output);
    assert.equal(config.maxFileSizeBytes, 4096);
  });

  it('does not trust forwarded headers by default', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'a'.repeat(32) });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(result.output).trustProxy, false);
  });

  it('accepts an explicit nginx hop count for proxy trust', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'a'.repeat(32), TRUST_PROXY: '1' });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(result.output).trustProxy, 1);
  });

  it('rejects malformed proxy trust configuration', () => {
    const result = runConfigWithEnv({ JWT_SECRET: 'a'.repeat(32), TRUST_PROXY: 'all' });
    assert.equal(result.ok, false);
    assert.match(result.error, /TRUST_PROXY/);
  });
});
