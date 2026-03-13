import 'dotenv/config';
import { resolve } from 'path';

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(name, fallback = null) {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: toInt(process.env.PORT, 3000),
  corsOrigin: process.env.CORS_ORIGIN || true,
  dbPath: resolve(process.cwd(), process.env.DB_PATH || './data/discord-clone.db'),
  uploadsRoot: resolve(process.cwd(), process.env.UPLOADS_ROOT || './uploads'),
  jwtSecret: required('JWT_SECRET', 'change-me-in-env-min-32-characters-please'),
  jwtAccessTtlSec: toInt(process.env.JWT_ACCESS_TTL_SEC, 900),
  jwtRefreshTtlSec: toInt(process.env.JWT_REFRESH_TTL_SEC, 60 * 60 * 24 * 30),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  workerId: toInt(process.env.SNOWFLAKE_WORKER_ID, 1) & 0x1f,
  processId: toInt(process.env.SNOWFLAKE_PROCESS_ID, 1) & 0x1f,
};
