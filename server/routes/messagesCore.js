import { Permissions, buildPermissionService } from '../services/permissions.js';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function cleanMessage(value) {
  const text = String(value || '').trim();
  return text.slice(0, 2000);
}

function parseMentions(content) {
  const text = String(content || '');
  const userIds = new Set();
  const roleIds = new Set();
  const channelIds = new Set();

  for (const m of text.matchAll(/<@!?([A-Za-z0-9_-]{2,64})>/g)) userIds.add(m[1]);
  for (const m of text.matchAll(/<@&([A-Za-z0-9_-]{2,64})>/g)) roleIds.add(m[1]);
  for (const m of text.matchAll(/<#([A-Za-z0-9_-]{2,64})>/g)) channelIds.add(m[1]);

  const mentionEveryone = /(^|\s)@(everyone|here)(?=\s|$|[!,.?])/i.test(text);
  return {
    userIds: [...userIds],
    roleIds: [...roleIds],
    channelIds: [...channelIds],
    mentionEveryone,
  };
}
export default async function messagesCoreRoutes(fastify, { db, authenticate, snowflake, io, config, fileService }) {
  const permissions = buildPermissionService(db);
  const uploadsRoot = config?.uploadsRoot;

  const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
  const getMessageById = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0');
  const getMessageByIdAnyChannel = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0');
  const getMessageNonce = db.prepare('SELECT message_id FROM message_nonces WHERE user_id = ? AND channel_id = ? AND nonce = ?');
  const insertMessageNonce = db.prepare(`
    INSERT INTO message_nonces (user_id, channel_id, nonce, message_id, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, channel_id, nonce) DO NOTHING
  `);
  const getAuthorLite = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?');
  const isGuildMember = db.prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?');
  const listGuildMemberIds = db.prepare('SELECT user_id FROM guild_members WHERE guild_id = ?');
  const listMemberIdsByRole = db.prepare('SELECT user_id FROM member_roles WHERE guild_id = ? AND role_id = ?');
  const listAttachmentsByMessage = db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY id ASC');
  const insertAttachment = db.prepare(`
    INSERT INTO attachments (
      id, message_id, filename, original_filename, content_type, size,
      url, proxy_url, width, height, duration_secs, waveform, description, spoiler, flags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listMessages = db.prepare(`
    SELECT *
    FROM messages
    WHERE channel_id = ?
      AND deleted = 0
      AND (? IS NULL OR id < ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const listMessagesAfter = db.prepare(`
    SELECT *
    FROM messages
    WHERE channel_id = ?
      AND deleted = 0
      AND id > ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);
  const listMessagesAroundBefore = db.prepare(`
    SELECT *
    FROM messages
    WHERE channel_id = ?
      AND deleted = 0
      AND id <= ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const listMessagesAroundAfter = db.prepare(`
    SELECT *
    FROM messages
    WHERE channel_id = ?
      AND deleted = 0
      AND id > ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);
  const getLatestMessageByAuthorInChannel = db.prepare(`
    SELECT created_at
    FROM messages
    WHERE channel_id = ? AND author_id = ? AND deleted = 0
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, channel_id, guild_id, author_id, content, type, flags, tts,
      mention_everyone, pinned, embeds, components, sticker_ids,
      poll, reference_message_id, reference_channel_id, created_at, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', '[]', NULL, ?, ?, ?, 0)
  `);

  const updateMessage = db.prepare('UPDATE messages SET content = ?, embeds = ?, edited_at = ? WHERE id = ? AND channel_id = ? AND deleted = 0');
  const softDeleteMessage = db.prepare('UPDATE messages SET deleted = 1, edited_at = ? WHERE id = ? AND channel_id = ?');
  const softDeleteBulkTemplate = (placeholders) => db.prepare(`
    UPDATE messages
    SET deleted = 1, edited_at = ?
    WHERE channel_id = ?
      AND id IN (${placeholders})
      AND deleted = 0
  `);
  const listBulkDeleteCandidatesTemplate = (placeholders) => db.prepare(`
    SELECT id, created_at
    FROM messages
    WHERE channel_id = ?
      AND id IN (${placeholders})
      AND deleted = 0
  `);
  const setChannelLastMessage = db.prepare('UPDATE channels SET last_message_id = ?, updated_at = ? WHERE id = ?');
  const insertMessageMention = db.prepare('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)');
  const insertMessageMentionRole = db.prepare('INSERT OR IGNORE INTO message_mention_roles (message_id, role_id) VALUES (?, ?)');
  const insertMessageMentionChannel = db.prepare('INSERT OR IGNORE INTO message_mention_channels (message_id, channel_id) VALUES (?, ?)');
  const upsertReadStateMentionCount = db.prepare(`
    INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
    VALUES (?, ?, NULL, 1)
    ON CONFLICT(user_id, channel_id)
    DO UPDATE SET mention_count = read_states.mention_count + 1
  `);
  const upsertAuthorReadState = db.prepare(`
    INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(user_id, channel_id)
    DO UPDATE SET last_read_message_id = excluded.last_read_message_id
  `);

  function canView(channelId, userId) {
    return permissions.hasChannelPermission(channelId, userId, Permissions.VIEW_CHANNEL);
  }

  function canReadHistory(channelId, userId) {
    return permissions.hasChannelPermission(channelId, userId, Permissions.READ_MESSAGE_HISTORY);
  }

  function canSend(channelId, userId) {
    return permissions.hasChannelPermission(channelId, userId, Permissions.SEND_MESSAGES);
  }

  function canManageMessages(channelId, userId) {
    return permissions.hasChannelPermission(channelId, userId, Permissions.MANAGE_MESSAGES);
  }

  async function parseCreateMessageInput(req, reply) {
    if (req.isMultipart && req.isMultipart()) {
      if (!fileService) {
        reply.code(500).send({ error: 'File service not configured' });
        return null;
      }

      const fields = {};
      const uploadedFiles = [];
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          uploadedFiles.push(part);
        } else {
          fields[part.fieldname] = part.value;
        }
      }

      if (uploadedFiles.length > 10) {
        reply.code(400).send({ error: 'Too many files (max 10)' });
        return null;
      }

      let metadata = [];
      let messageReference = null;
      if (fields.attachments) {
        try {
          const parsed = JSON.parse(String(fields.attachments));
          if (Array.isArray(parsed)) metadata = parsed;
        } catch {
          reply.code(400).send({ error: 'Invalid attachments metadata JSON' });
          return null;
        }
      }

      if (fields.message_reference) {
        try {
          const parsed = JSON.parse(String(fields.message_reference));
          if (parsed && typeof parsed === 'object') messageReference = parsed;
        } catch {
          reply.code(400).send({ error: 'Invalid message_reference JSON' });
          return null;
        }
      }

      const attachments = [];
      for (let i = 0; i < uploadedFiles.length; i += 1) {
        const filePart = uploadedFiles[i];
        const uploaded = await fileService.uploadTempFile({ userId: req.user.id, file: filePart });
        const meta = metadata[i] && typeof metadata[i] === 'object' ? metadata[i] : {};
        attachments.push({
          url: uploaded.url,
          filename: String(meta.filename || uploaded.filename),
          size: Number(meta.size || uploaded.size || 0),
          mime_type: String(meta.mime_type || uploaded.mime_type || 'application/octet-stream'),
          description: meta.description ? String(meta.description).slice(0, 1024) : undefined,
          spoiler: !!meta.spoiler,
          flags: Number(meta.flags || 0),
        });
      }

      return {
        content: cleanMessage(fields.content || ''),
        attachments,
        nonce: fields.nonce ? String(fields.nonce).trim().slice(0, 128) : null,
        message_reference: messageReference,
      };
    }

    return {
      content: cleanMessage(req.body?.content || ''),
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
      nonce: req.body?.nonce ? String(req.body.nonce).trim().slice(0, 128) : null,
      message_reference: req.body?.message_reference && typeof req.body.message_reference === 'object' ? req.body.message_reference : null,
      poll: req.body?.poll && typeof req.body.poll === 'object' ? req.body.poll : null,
    };
  }

  function enrichMessage(row) {
    const author = getAuthorLite.get(row.author_id);
    const attachments = listAttachmentsByMessage.all(row.id).map((a) => ({
      id: a.id,
      message_id: a.message_id,
      filename: a.filename,
      original_filename: a.original_filename,
      content_type: a.content_type,
      size: a.size,
      url: a.url,
      proxy_url: a.proxy_url,
      width: a.width,
      height: a.height,
      duration_secs: a.duration_secs,
      waveform: a.waveform,
      description: a.description,
      spoiler: !!a.spoiler,
      flags: a.flags,
    }));
    let embeds = [];
    try {
      embeds = JSON.parse(row.embeds || '[]');
      if (!Array.isArray(embeds)) embeds = [];
    } catch {
      embeds = [];
    }

    const reactionsRaw = db.prepare(`
      SELECT emoji_name, user_id
      FROM message_reactions
      WHERE message_id = ?
    `).all(row.id);
    
    // Group reactions by emoji
    const reactionGroups = {};
    for (const r of reactionsRaw) {
      if (!reactionGroups[r.emoji_name]) {
        reactionGroups[r.emoji_name] = { count: 0, me: false };
      }
      reactionGroups[r.emoji_name].count++;
      // Since we don't pass req.user.id to enrichMessage usually, we'll mark 'me' in UI or just pass the whole list if needed, or check if they are in the array
      // To keep it simple, we just array of users, or boolean if we change signature. 
      // For now, let's just return count and true/false if we can, but we don't have user context here. 
      // Better: return array of user IDs or just don't handle `me` correctly yet (Discord returns `me: bool` but that requires user context).
      // Let's just say a reaction object has `{ emoji: { name: '...' }, count: N }`
    }
    
    const reactions = Object.keys(reactionGroups).map(emoji => ({
      emoji: { name: emoji },
      count: reactionGroups[emoji].count,
    }));

    return {
      id: row.id,
      channel_id: row.channel_id,
      guild_id: row.guild_id,
      author_id: row.author_id,
      content: row.content,
      reference_message_id: row.reference_message_id,
      reference_channel_id: row.reference_channel_id,
      attachments,
      embeds,
      reactions,
      type: row.type,
      flags: row.flags,
      pinned: row.pinned,
      edited_at: row.edited_at,
      created_at: row.created_at,
      author,
      referenced_message: row.reference_message_id
        ? (() => {
            const ref = getMessageByIdAnyChannel.get(row.reference_message_id);
            if (!ref) return null;
            return {
              id: ref.id,
              channel_id: ref.channel_id,
              guild_id: ref.guild_id,
              author_id: ref.author_id,
              content: ref.content,
              created_at: ref.created_at,
              author: getAuthorLite.get(ref.author_id),
            };
          })()
        : null,
      poll: (() => {
        const poll = db.prepare('SELECT * FROM polls WHERE message_id = ?').get(row.id);
        if (!poll) return null;
        const answers = db.prepare('SELECT * FROM poll_answers WHERE message_id = ? ORDER BY id').all(row.id);
        const voteCounts = {};
        for (const vc of db.prepare('SELECT answer_id, COUNT(*) AS count FROM poll_votes WHERE message_id = ? GROUP BY answer_id').all(row.id)) {
          voteCounts[vc.answer_id] = vc.count;
        }
        return {
          question: poll.question,
          allow_multiselect: !!poll.allow_multiselect,
          expiry: poll.expiry,
          layout_type: poll.layout_type,
          answers: answers.map(a => ({
            id: a.id,
            text: a.text,
            emoji: a.emoji,
            count: voteCounts[a.id] || 0,
          })),
        };
      })(),
    };
  }

  fastify.get('/api/channels/:channelId/messages', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          before: { type: 'string', minLength: 1, maxLength: 40 },
          after: { type: 'string', minLength: 1, maxLength: 40 },
          around: { type: 'string', minLength: 1, maxLength: 40 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    if (!canView(channel.id, req.user.id)) {
      return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });
    }
    if (!canReadHistory(channel.id, req.user.id)) {
      return reply.code(403).send({ error: 'Missing READ_MESSAGE_HISTORY permission' });
    }

    const limit = req.query.limit ?? 50;
    const before = req.query.before ?? null;
    const after = req.query.after ?? null;
    const around = req.query.around ?? null;
    let rows;

    if (around) {
      const half = Math.floor(limit / 2);
      const beforeRows = listMessagesAroundBefore.all(channel.id, around, half + 1);
      const afterRows = listMessagesAroundAfter.all(channel.id, around, limit - beforeRows.length);
      rows = [...beforeRows, ...afterRows.reverse()].slice(0, limit);
    } else if (after) {
      rows = listMessagesAfter.all(channel.id, after, limit).reverse();
    } else {
      rows = listMessages.all(channel.id, before, before, limit);
    }

    return rows.map(enrichMessage);
  });

  fastify.post('/api/upload', {
    preHandler: authenticate,
  }, async (req, reply) => {
    if (!uploadsRoot) return reply.code(500).send({ error: 'Uploads not configured' });
    if (!fileService) return reply.code(500).send({ error: 'File service not configured' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'No file provided' });
    const uploaded = await fileService.uploadTempFile({ userId: req.user.id, file });
    return reply.code(201).send(uploaded);
  });

  fastify.post('/api/channels/:channelId/messages', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', maxLength: 2000, default: '' },
          nonce: { type: 'string', minLength: 1, maxLength: 128 },
          message_reference: {
            type: 'object',
            additionalProperties: false,
            required: ['message_id'],
            properties: {
              message_id: { type: 'string', minLength: 1, maxLength: 64 },
              channel_id: { type: 'string', minLength: 1, maxLength: 64 },
            },
          },
          attachments: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['url', 'filename', 'size'],
              properties: {
                url: { type: 'string', minLength: 1, maxLength: 2048 },
                filename: { type: 'string', minLength: 1, maxLength: 255 },
                size: { type: 'integer', minimum: 0 },
                mime_type: { type: 'string', maxLength: 255 },
                description: { type: 'string', maxLength: 1024 },
                spoiler: { type: 'boolean', default: false },
                flags: { type: 'integer', minimum: 0, default: 0 },
              },
            },
          },
          reply_to_id: { type: 'string', maxLength: 64 },
          poll: {
            type: 'object',
            properties: {
              question: { type: 'string', maxLength: 300 },
              answers: { type: 'array', maxItems: 10 },
              allow_multiselect: { type: 'boolean' },
              duration_hours: { type: 'integer', minimum: 1, maximum: 720 },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    if (!canSend(channel.id, req.user.id)) {
      return reply.code(403).send({ error: 'Missing SEND_MESSAGES permission' });
    }

    const slowmodeSec = Number(channel.rate_limit_per_user || 0);
    if (slowmodeSec > 0 && !canManageMessages(channel.id, req.user.id)) {
      const lastByAuthor = getLatestMessageByAuthorInChannel.get(channel.id, req.user.id);
      if (lastByAuthor?.created_at) {
        const delta = nowSec() - Number(lastByAuthor.created_at);
        if (delta < slowmodeSec) {
          const retryAfter = slowmodeSec - delta;
          reply.header('Retry-After', String(retryAfter));
          return reply.code(429).send({ error: 'Slowmode is enabled', retry_after: retryAfter });
        }
      }
    }

    const input = await parseCreateMessageInput(req, reply);
    if (!input) return;
    const content = input.content;
    const attachments = input.attachments;
    const nonce = input.nonce || null;
    const messageReference = input.message_reference || null;
    const pollData = input.poll || (req.body?.poll && typeof req.body.poll === 'object' ? req.body.poll : null);

    // Legacy reply_to_id support
    if (!messageReference && req.body?.reply_to_id) {
      input.message_reference = { message_id: req.body.reply_to_id };
    }

    if (nonce) {
      const existingNonce = getMessageNonce.get(req.user.id, channel.id, nonce);
      if (existingNonce?.message_id) {
        const existingMessage = getMessageById.get(existingNonce.message_id, channel.id);
        if (existingMessage) return enrichMessage(existingMessage);
      }
    }

    let referenceMessageId = null;
    let referenceChannelId = null;
    if (messageReference?.message_id) {
      const ref = getMessageByIdAnyChannel.get(String(messageReference.message_id));
      if (!ref) {
        return reply.code(400).send({ error: 'Invalid message reference' });
      }
      if (ref.guild_id !== channel.guild_id) {
        return reply.code(400).send({ error: 'Referenced message must be in same guild' });
      }
      if (messageReference.channel_id && String(messageReference.channel_id) !== String(ref.channel_id)) {
        return reply.code(400).send({ error: 'Invalid reference channel' });
      }
      referenceMessageId = ref.id;
      referenceChannelId = ref.channel_id;
    }

    if (!content && attachments.length === 0 && !pollData) {
      return reply.code(400).send({ error: 'Message content is empty' });
    }

    const id = snowflake.generate();
    const ts = nowSec();
    const generatedEmbeds = await fastify.embedService.generateEmbedsFromContent(content);
    const embedsJson = JSON.stringify(generatedEmbeds);
    const mentionMeta = parseMentions(content);
    const mentionTargetUsers = new Set();

    for (const userId of mentionMeta.userIds) {
      if (userId !== req.user.id && isGuildMember.get(channel.guild_id, userId)) {
        mentionTargetUsers.add(userId);
      }
    }
    if (mentionMeta.mentionEveryone) {
      for (const row of listGuildMemberIds.all(channel.guild_id)) {
        if (row.user_id !== req.user.id) mentionTargetUsers.add(row.user_id);
      }
    }
    for (const roleId of mentionMeta.roleIds) {
      for (const row of listMemberIdsByRole.all(channel.guild_id, roleId)) {
        if (row.user_id !== req.user.id) mentionTargetUsers.add(row.user_id);
      }
    }

    const finalizedAttachments = [];

    if (attachments.length) {
      if (!fileService) return reply.code(500).send({ error: 'File service not configured' });
      for (const attachment of attachments) {
        try {
          const finalized = await fileService.finalizeTempAttachment({
            userId: req.user.id,
            channelId: channel.id,
            messageId: id,
            attachment,
          });
          finalizedAttachments.push(finalized);
        } catch (error) {
          const statusCode = error?.statusCode || 400;
          return reply.code(statusCode).send({ error: error?.message || 'Attachment processing failed' });
        }
      }

      const totalSize = finalizedAttachments.reduce((acc, item) => acc + (item.size || 0), 0);
      if (totalSize > 100 * 1024 * 1024) {
        return reply.code(413).send({ error: 'Attachments total size is too large' });
      }
    }

    db.transaction(() => {
      insertMessage.run(
        id,
        channel.id,
        channel.guild_id,
        req.user.id,
        content,
        referenceMessageId ? 19 : 0,
        0,
        0,
        mentionMeta.mentionEveryone ? 1 : 0,
        embedsJson,
        referenceMessageId,
        referenceChannelId,
        ts,
      );

      if (nonce) {
        insertMessageNonce.run(req.user.id, channel.id, nonce, id, ts);
      }

      for (const userId of mentionTargetUsers) {
        insertMessageMention.run(id, userId);
        upsertReadStateMentionCount.run(userId, channel.id);
      }
      for (const roleId of mentionMeta.roleIds) {
        insertMessageMentionRole.run(id, roleId);
      }
      for (const channelId of mentionMeta.channelIds) {
        insertMessageMentionChannel.run(id, channelId);
      }
      upsertAuthorReadState.run(req.user.id, channel.id, id);

      for (const finalized of finalizedAttachments) {
        insertAttachment.run(
          finalized.id,
          finalized.message_id,
          finalized.filename,
          finalized.original_filename,
          finalized.content_type,
          finalized.size,
          finalized.url,
          finalized.proxy_url,
          finalized.width,
          finalized.height,
          finalized.duration_secs,
          finalized.waveform,
          finalized.description,
          finalized.spoiler,
          finalized.flags,
        );
      }
      setChannelLastMessage.run(id, ts, channel.id);

      // Create poll if provided
      if (pollData && pollData.question && Array.isArray(pollData.answers) && pollData.answers.length >= 2) {
        const durationHours = pollData.duration_hours || 24;
        const expiry = ts + (durationHours * 3600);
        db.prepare('INSERT INTO polls (message_id, question, allow_multiselect, expiry, layout_type) VALUES (?, ?, ?, ?, ?)')
          .run(id, pollData.question, pollData.allow_multiselect ? 1 : 0, expiry, 1);
        for (const ans of pollData.answers) {
          db.prepare('INSERT INTO poll_answers (id, message_id, text, emoji) VALUES (?, ?, ?, ?)')
            .run(ans.id || 0, id, ans.text || '', ans.emoji || null);
        }
      }
    })();

    const message = enrichMessage(getMessageById.get(id, channel.id));
    io?.to(`guild:${channel.guild_id}`)?.emit('message:create', message);
    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_CREATE', message);
    for (const targetUserId of mentionTargetUsers) {
      io?.to(`user:${targetUserId}`)?.emit('mention', {
        user_id: targetUserId,
        guild_id: channel.guild_id,
        channel_id: channel.id,
        message_id: id,
      });
    }

    return reply.code(201).send(message);
  });

  fastify.patch('/api/channels/:channelId/messages/:messageId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    const existing = getMessageById.get(req.params.messageId, channel.id);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const isAuthor = existing.author_id === req.user.id;
    const canModerate = canManageMessages(channel.id, req.user.id);
    if (!isAuthor && !canModerate) {
      return reply.code(403).send({ error: 'No permission to edit this message' });
    }

    const next = cleanMessage(req.body.content);
    if (!next) return reply.code(400).send({ error: 'Message content is empty' });

    const generatedEmbeds = await fastify.embedService.generateEmbedsFromContent(next);
    updateMessage.run(next, JSON.stringify(generatedEmbeds), nowSec(), existing.id, channel.id);
    const updated = enrichMessage(getMessageById.get(existing.id, channel.id));
    io?.to(`guild:${channel.guild_id}`)?.emit('message:update', updated);
    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_UPDATE', updated);

    return updated;
  });

  fastify.patch('/api/messages/:messageId', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
  }, async (req, reply) => {
    const existing = getMessageByIdAnyChannel.get(req.params.messageId);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const channel = getChannelById.get(existing.channel_id);
    if (!channel || !channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    const isAuthor = existing.author_id === req.user.id;
    const canModerate = canManageMessages(channel.id, req.user.id);
    if (!isAuthor && !canModerate) {
      return reply.code(403).send({ error: 'No permission to edit this message' });
    }

    const next = cleanMessage(req.body.content);
    if (!next) return reply.code(400).send({ error: 'Message content is empty' });

    const generatedEmbeds = await fastify.embedService.generateEmbedsFromContent(next);
    updateMessage.run(next, JSON.stringify(generatedEmbeds), nowSec(), existing.id, channel.id);
    const updated = enrichMessage(getMessageById.get(existing.id, channel.id));
    io?.to(`guild:${channel.guild_id}`)?.emit('message:update', updated);
    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_UPDATE', updated);

    return updated;
  });

  fastify.delete('/api/channels/:channelId/messages/:messageId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    const existing = getMessageById.get(req.params.messageId, channel.id);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const isAuthor = existing.author_id === req.user.id;
    const canModerate = canManageMessages(channel.id, req.user.id);
    if (!isAuthor && !canModerate) {
      return reply.code(403).send({ error: 'No permission to delete this message' });
    }

    softDeleteMessage.run(nowSec(), existing.id, channel.id);

    io?.to(`guild:${channel.guild_id}`)?.emit('message:delete', {
      id: existing.id,
      channel_id: channel.id,
      guild_id: channel.guild_id,
    });
    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_DELETE', {
      message_id: existing.id,
      channel_id: channel.id,
      guild_id: channel.guild_id,
    });

    return { ok: true };
  });

  fastify.delete('/api/messages/:messageId', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const existing = getMessageByIdAnyChannel.get(req.params.messageId);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const channel = getChannelById.get(existing.channel_id);
    if (!channel || !channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    const isAuthor = existing.author_id === req.user.id;
    const canModerate = canManageMessages(channel.id, req.user.id);
    if (!isAuthor && !canModerate) {
      return reply.code(403).send({ error: 'No permission to delete this message' });
    }

    softDeleteMessage.run(nowSec(), existing.id, channel.id);

    io?.to(`guild:${channel.guild_id}`)?.emit('message:delete', {
      id: existing.id,
      channel_id: channel.id,
      guild_id: channel.guild_id,
    });
    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_DELETE', {
      message_id: existing.id,
      channel_id: channel.id,
      guild_id: channel.guild_id,
    });

    return { ok: true };
  });

  fastify.post('/api/channels/:channelId/messages/bulk-delete', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['messages'],
        properties: {
          messages: {
            type: 'array',
            minItems: 2,
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    if (!canManageMessages(channel.id, req.user.id)) {
      return reply.code(403).send({ error: 'Missing MANAGE_MESSAGES permission' });
    }

    const uniqueIds = [...new Set((req.body.messages || []).map((id) => String(id).trim()).filter(Boolean))];
    if (uniqueIds.length < 2 || uniqueIds.length > 100) {
      return reply.code(400).send({ error: 'Messages count must be between 2 and 100' });
    }

    const placeholders = uniqueIds.map(() => '?').join(',');
    const listCandidates = listBulkDeleteCandidatesTemplate(placeholders);
    const candidates = listCandidates.all(channel.id, ...uniqueIds);
    if (!candidates.length) return { ok: true, deleted: 0, ids: [] };

    const now = nowSec();
    const maxAgeSec = 14 * 24 * 60 * 60;
    const tooOld = candidates.some((m) => (now - Number(m.created_at || 0)) > maxAgeSec);
    if (tooOld) {
      return reply.code(400).send({ error: 'Cannot bulk delete messages older than 14 days' });
    }

    const editableIds = candidates.map((m) => m.id);
    const deletePlaceholders = editableIds.map(() => '?').join(',');
    const softDeleteBulk = softDeleteBulkTemplate(deletePlaceholders);
    const ts = nowSec();
    softDeleteBulk.run(ts, channel.id, ...editableIds);
    
    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_DELETE_BULK', {
      ids: editableIds,
      channel_id: channel.id,
      guild_id: channel.guild_id,
    });
    return { ok: true, deleted: editableIds.length, ids: editableIds };
  });

  // ═══════════════════════════════════════════════════════
  // REACTIONS
  // ═══════════════════════════════════════════════════════

  fastify.put('/api/channels/:channelId/messages/:messageId/reactions/:emoji/@me', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported in this endpoint' });

    if (!canView(channel.id, req.user.id)) return reply.code(403).send({ error: 'Missing VIEW_CHANNEL permission' });
    if (!canReadHistory(channel.id, req.user.id)) return reply.code(403).send({ error: 'Missing READ_MESSAGE_HISTORY permission' });

    const existing = getMessageById.get(req.params.messageId, channel.id);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const emoji = decodeURIComponent(req.params.emoji);
    
    db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, emoji_name, user_id, created_at) VALUES (?, ?, ?, ?)').run(existing.id, emoji, req.user.id, nowSec());

    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_REACTION_ADD', {
      user_id: req.user.id,
      channel_id: channel.id,
      message_id: existing.id,
      guild_id: channel.guild_id,
      emoji: { name: emoji }
    });

    return { ok: true };
  });

  fastify.delete('/api/channels/:channelId/messages/:messageId/reactions/:emoji/@me', {
    preHandler: authenticate,
  }, async (req, reply) => {
    const channel = getChannelById.get(req.params.channelId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!channel.guild_id) return reply.code(400).send({ error: 'Only guild channels are supported' });

    const existing = getMessageById.get(req.params.messageId, channel.id);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    const emoji = decodeURIComponent(req.params.emoji);

    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND emoji_name = ? AND user_id = ?').run(existing.id, emoji, req.user.id);

    io?.to(`guild:${channel.guild_id}`)?.emit('MESSAGE_REACTION_REMOVE', {
      user_id: req.user.id,
      channel_id: channel.id,
      message_id: existing.id,
      guild_id: channel.guild_id,
      emoji: { name: emoji }
    });

    return { ok: true };
  });
}
