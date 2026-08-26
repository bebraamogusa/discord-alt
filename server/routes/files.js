import { existsSync, createReadStream } from 'fs';
import { join, extname, basename } from 'path';
import { Permissions, buildPermissionService } from '../services/permissions.js';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.json': 'application/json',
};

function contentDisposition(ext, filename) {
  const safeName = basename(filename).replace(/["\\\r\n]/g, '_');
  return `${ext === '.svg' ? 'attachment' : 'inline'}; filename="${safeName || 'file'}"`;
}

export default async function fileRoutes(fastify, { db, config, authenticate }) {
  const permissions = buildPermissionService(db);
  const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');

  fastify.get('/files/*', { preHandler: authenticate }, async (req, reply) => {
    const rel = req.params['*'];
    if (!rel || rel.includes('..') || rel.includes('\\')) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    if (rel.startsWith('attachments/temp/')) {
      const userId = rel.split('/')[2];
      if (userId !== req.user.id) return reply.code(403).send({ error: 'Access denied' });
    } else if (rel.startsWith('attachments/')) {
      const channelId = rel.split('/')[1];
      if (channelId) {
        const channel = getChannelById.get(channelId);
        const canAccess = channel?.guild_id
          ? permissions.hasChannelPermission(channelId, req.user.id, Permissions.VIEW_CHANNEL)
          : !!db.prepare('SELECT 1 FROM dm_participants WHERE channel_id = ? AND user_id = ? AND closed = 0').get(channelId, req.user.id);
        if (!channel || !canAccess) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }
    } else {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const fullPath = join(config.uploadsRoot, rel);
    if (!existsSync(fullPath)) return reply.code(404).send({ error: 'File not found' });

    const ext = extname(fullPath).toLowerCase();
    reply.header('Content-Type', MIME[ext] || 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition(ext, fullPath));
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(createReadStream(fullPath));
  });
}
