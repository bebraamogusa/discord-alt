import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

import { config } from './config.js';
import { createDatabase, runMigrations } from './database.js';
import { SnowflakeGenerator } from './snowflake.js';
import { buildAuthMiddleware } from './middleware/auth.js';
import { buildAuthService } from './services/authService.js';
import { buildEmbedService } from './services/embedService.js';
import { buildFileService } from './services/fileService.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import guildsCoreRoutes from './routes/guildsCore.js';
import messagesCoreRoutes from './routes/messagesCore.js';
import socialCoreRoutes from './routes/socialCore.js';
import embedsCoreRoutes from './routes/embedsCore.js';
import { buildSocketServer } from './socket.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLIENT_ROOT = join(ROOT, 'client');

const db = createDatabase(config.dbPath);
runMigrations(db, join(__dirname, 'migrations'));
mkdirSync(config.uploadsRoot, { recursive: true });

const snowflake = new SnowflakeGenerator(config.workerId, config.processId);
const authService = buildAuthService({ db, snowflake, config });
const embedService = buildEmbedService();
const fileService = buildFileService({ uploadsRoot: config.uploadsRoot, snowflake });

const app = Fastify({
  logger: config.env !== 'test',
  ajv: {
    customOptions: {
      removeAdditional: true,
      coerceTypes: true,
      useDefaults: true,
    },
  },
});

app.decorate('embedService', embedService);

await app.register(fastifyCors, {
  origin: config.corsOrigin,
  credentials: true,
});

await app.register(fastifyCookie);
await app.register(fastifyFormbody);

await app.register(fastifyMultipart, {
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 10,
    fieldSize: 5 * 1024 * 1024,
  },
});

await app.register(fastifyStatic, {
  root: CLIENT_ROOT,
  prefix: '/',
});

await app.register(fastifyStatic, {
  root: config.uploadsRoot,
  prefix: '/files/',
  decorateReply: false,
  immutable: true,
  maxAge: '1y',
  etag: true,
});

const authenticate = buildAuthMiddleware({ db, jwtSecret: config.jwtSecret });

await app.register(authRoutes, { authService, config, authenticate });
await app.register(usersRoutes, { db, authenticate, authService, config });
await app.register(embedsCoreRoutes, { authenticate, embedService });
const io = buildSocketServer(app.server, { db, config });
await app.register(guildsCoreRoutes, { db, authenticate, snowflake, io });
await app.register(messagesCoreRoutes, { db, authenticate, snowflake, io, config, fileService });
await app.register(socialCoreRoutes, { db, authenticate, snowflake, io });

app.get('/app', async (_req, reply) => {
  return reply.sendFile('app.html');
});

app.get('/', async (_req, reply) => {
  return reply.redirect('/app');
});

app.get('/api/health', async () => ({
  ok: true,
  env: config.env,
  now: Date.now(),
}));

app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  if (reply.sent) return;
  reply.code(error.statusCode || 500).send({
    error: error.message || 'Internal server error',
  });
});

await app.listen({ host: config.host, port: config.port });

app.log.info(`core server listening on ${config.host}:${config.port}`);
