import 'dotenv/config';
import { resolve } from 'path';

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = toInt(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function parseTrustProxy(value) {
  if (!value) return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^(?:loopback|linklocal|uniquelocal)$/i.test(value) || /^[0-9a-f:./,-]+$/i.test(value)) return value;
  throw new Error('TRUST_PROXY must be false, true, a hop count, or a proxy address');
}

function assertJwtSecret(value) {
  const normalized = value.trim().toLowerCase();
  const placeholders = new Set([
    'change_this_to_a_long_random_secret_at_least_32_chars',
    'change-me-in-env-min-32-characters-please',
    'replace_with_a_long_random_secret',
    'your_jwt_secret_here',
    'the-generated-secret',
  ]);
  if (placeholders.has(normalized)) {
    throw new Error('JWT_SECRET must not be a placeholder');
  }
  if (value.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return value;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: toInt(process.env.PORT, 3000),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  corsOrigin: (() => {
    if (process.env.CORS_ORIGIN) {
      return process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
    }
    return process.env.NODE_ENV === 'production' ? [] : true;
  })(),
  dbPath: resolve(process.cwd(), process.env.DB_PATH || './data/discord-clone.db'),
  uploadsRoot: resolve(process.cwd(), process.env.UPLOADS_ROOT || './uploads'),
  maxFileSizeBytes: toPositiveInt(process.env.MAX_FILE_SIZE, 100 * 1024 * 1024),
  tempFileMaxAgeMs: toPositiveInt(process.env.TEMP_FILE_MAX_AGE_SEC, 24 * 60 * 60) * 1000,
  jwtSecret: (() => {
    const val = required('JWT_SECRET');
    return assertJwtSecret(val);
  })(),
  jwtAccessTtlSec: toInt(process.env.JWT_ACCESS_TTL_SEC, 900),
  jwtRefreshTtlSec: toInt(process.env.JWT_REFRESH_TTL_SEC, 60 * 60 * 24 * 30),
  mfaMaxAttempts: toPositiveInt(process.env.MFA_MAX_ATTEMPTS, 5),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  cookieSameSite: process.env.COOKIE_SAMESITE || 'lax',
  workerId: toInt(process.env.SNOWFLAKE_WORKER_ID, 1) & 0x1f,
  processId: toInt(process.env.SNOWFLAKE_PROCESS_ID, 1) & 0x1f,
};
