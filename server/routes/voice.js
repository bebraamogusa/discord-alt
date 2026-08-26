import { getOrCreateRouter, createWebRtcTransport, mediaState, routers, voiceLimits, cleanupPeer } from '../media/mediasoup.js';
import { buildPermissionService, Permissions } from '../services/permissions.js';

export default async function voiceRoutes(fastify, options) {
  const { authenticate, db } = options;
  const permissions = buildPermissionService(db);
  const requestRates = new Map();
  const RATE_WINDOW_MS = 1000;
  const RATE_LIMIT = 20;

  const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
  const getGuildMember = db.prepare('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?');

  function allowRequest(userId, action) {
    const now = Date.now();
    for (const [key, entry] of requestRates) {
      if (now - entry.startedAt >= RATE_WINDOW_MS) requestRates.delete(key);
    }
    const key = `${userId}:${action}`;
    const entry = requestRates.get(key);
    if (!entry || now - entry.startedAt >= RATE_WINDOW_MS) {
      requestRates.set(key, { startedAt: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE_LIMIT;
  }

  function rejectRate(req, res, action) {
    if (allowRequest(req.user.id, action)) return false;
    res.code(429).send({ error: 'Voice request rate limit exceeded' });
    return true;
  }

  function countResources(field, metaField, value) {
    let count = 0;
    for (const meta of mediaState[metaField].values()) if (meta[field] === value) count += 1;
    return count;
  }

  function peerFor(userId) {
    return mediaState.peers.get(userId) || { transportIds: [], producerIds: [], consumerIds: [] };
  }

  function requireVoiceAccess(channelId, userId, res) {
    const channel = getChannelById.get(channelId);
    if (!channel || !channel.guild_id) {
      res.code(404).send({ error: 'Channel not found' });
      return null;
    }
    const member = getGuildMember.get(channel.guild_id, userId);
    if (!member) {
      res.code(403).send({ error: 'Not a guild member' });
      return null;
    }
    if (!permissions.hasChannelPermission(channel.id, userId, Permissions.CONNECT)) {
      res.code(403).send({ error: 'Missing CONNECT permission' });
      return null;
    }
    return channel;
  }

  fastify.post('/join', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'join')) return;
    const { channel_id } = req.body;
    if (!channel_id) return res.code(400).send({ error: 'Missing channel_id' });

    const channel = requireVoiceAccess(channel_id, req.user.id, res);
    if (!channel) return;

    const router = await getOrCreateRouter(channel_id);
    return {
      routerRtpCapabilities: router.rtpCapabilities
    };
  });

  fastify.post('/transport/create', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'transport:create')) return;
    const { channel_id } = req.body;
    if (!channel_id) return res.code(400).send({ error: 'Missing channel_id' });

    const channel = requireVoiceAccess(channel_id, req.user.id, res);
    if (!channel) return;

    const peer = peerFor(req.user.id);
    if (peer.transportIds.length >= voiceLimits.transportsPerUser ||
      countResources('channelId', 'transportMeta', channel_id) >= voiceLimits.transportsPerChannel) {
      return res.code(429).send({ error: 'Voice transport quota exceeded' });
    }

    const router = await getOrCreateRouter(channel_id);
    const transport = await createWebRtcTransport(router);

    mediaState.transportMeta.set(transport.id, { channelId: channel_id });

    peer.transportIds.push(transport.id);
    mediaState.peers.set(req.user.id, peer);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    };
  });

  fastify.post('/transport/connect', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'transport:connect')) return;
    const { transportId, dtlsParameters } = req.body;
    const transport = mediaState.transports.get(transportId);
    if (!transport) {
      return res.code(404).send({ error: 'Transport not found' });
    }

    const peer = mediaState.peers.get(req.user.id);
    if (!peer || !peer.transportIds.includes(transportId)) {
      return res.code(403).send({ error: 'Transport does not belong to you' });
    }

    const meta = mediaState.transportMeta.get(transportId);
    if (meta) {
      const check = requireVoiceAccess(meta.channelId, req.user.id, res);
      if (!check) return;
    }

    try {
      await transport.connect({ dtlsParameters });
      return { success: true };
    } catch (err) {
      return res.code(500).send({ error: err.message });
    }
  });

  fastify.post('/produce', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'produce')) return;
    const { transportId, kind, rtpParameters, appData } = req.body;
    
    const transport = mediaState.transports.get(transportId);
    if (!transport) {
      return res.code(404).send({ error: 'Transport not found' });
    }

    const peer = mediaState.peers.get(req.user.id);
    if (!peer || !peer.transportIds.includes(transportId)) {
      return res.code(403).send({ error: 'Transport does not belong to you' });
    }

    const tMeta = mediaState.transportMeta.get(transportId);
    if (appData?.channel_id && tMeta?.channelId && appData.channel_id !== tMeta.channelId) {
      return res.code(400).send({ error: 'appData.channel_id does not match transport channel' });
    }
    const channelId = tMeta?.channelId;
    if (!channelId) {
      return res.code(400).send({ error: 'Transport has no channel context' });
    }
    const check = requireVoiceAccess(channelId, req.user.id, res);
    if (!check) return;

    if (peer.producerIds.length >= voiceLimits.producersPerUser ||
      countResources('channelId', 'producerMeta', channelId) >= voiceLimits.producersPerChannel) {
      return res.code(429).send({ error: 'Voice producer quota exceeded' });
    }

    try {
      const producer = await transport.produce({ kind, rtpParameters, appData });
      mediaState.producers.set(producer.id, producer);
      mediaState.producerMeta.set(producer.id, { channelId: channelId || tMeta?.channelId, userId: req.user.id });
      
      if (peer) peer.producerIds.push(producer.id);

      producer.on('transportclose', () => {
        mediaState.producers.delete(producer.id);
        mediaState.producerMeta.delete(producer.id);
        peer.producerIds = peer.producerIds.filter((id) => id !== producer.id);
      });

      if (channelId && fastify.io) {
        fastify.io.to(`channel:${channelId}`).emit('voice:producer_added', {
          producerId: producer.id,
          user_id: req.user.id,
          kind,
          appData
        });
      }

      return { id: producer.id };
    } catch (err) {
      return res.code(500).send({ error: err.message });
    }
  });

  fastify.post('/producers/close', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'producer:close')) return;
    const { producerId } = req.body;
    const producer = mediaState.producers.get(producerId);
    if (!producer) {
      return res.code(404).send({ error: 'Producer not found' });
    }
    const peer = mediaState.peers.get(req.user.id);
    if (!peer || !peer.producerIds.includes(producerId)) {
      return res.code(403).send({ error: 'Producer does not belong to you' });
    }
    mediaState.producers.delete(producerId);
    mediaState.producerMeta.delete(producerId);
    peer.producerIds = peer.producerIds.filter((id) => id !== producerId);
    try {
      producer.close();
    } catch (err) {
      return res.code(500).send({ error: err.message });
    }
    return { success: true };
  });

  fastify.post('/consume', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'consume')) return;
    const { transportId, producerId, rtpCapabilities, channel_id } = req.body;
    
    const producer = mediaState.producers.get(producerId);
    if (!producer) {
      return res.code(404).send({ error: 'Producer not found' });
    }

    const producerMeta = mediaState.producerMeta.get(producerId);
    const effectiveChannelId = channel_id || producerMeta?.channelId;
    if (!effectiveChannelId) {
      return res.code(400).send({ error: 'Missing channel context' });
    }

    const check = requireVoiceAccess(effectiveChannelId, req.user.id, res);
    if (!check) return;

    const router = routers.get(effectiveChannelId);
    if (!router) {
      return res.code(404).send({ error: 'Router not found for channel' });
    }

    if (producerMeta && producerMeta.channelId !== effectiveChannelId) {
      return res.code(400).send({ error: 'Producer is not in this channel' });
    }

    const transport = mediaState.transports.get(transportId);
    if (!transport) {
      return res.code(404).send({ error: 'Transport not found' });
    }

    const peer = mediaState.peers.get(req.user.id);
    if (!peer || !peer.transportIds.includes(transportId)) {
      return res.code(403).send({ error: 'Transport does not belong to you' });
    }

    if (peer.consumerIds.length >= voiceLimits.consumersPerUser ||
      countResources('channelId', 'consumerMeta', effectiveChannelId) >= voiceLimits.consumersPerChannel) {
      return res.code(429).send({ error: 'Voice consumer quota exceeded' });
    }

    const tMeta = mediaState.transportMeta.get(transportId);
    if (tMeta && tMeta.channelId !== effectiveChannelId) {
      return res.code(400).send({ error: 'Transport is not in this channel' });
    }

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return res.code(400).send({ error: 'Cannot consume' });
    }

    try {
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      });

      mediaState.consumers.set(consumer.id, consumer);
      mediaState.consumerMeta.set(consumer.id, { channelId: effectiveChannelId, userId: req.user.id });
      
      if (peer) peer.consumerIds.push(consumer.id);

      consumer.on('transportclose', () => {
        mediaState.consumers.delete(consumer.id);
        mediaState.consumerMeta.delete(consumer.id);
        peer.consumerIds = peer.consumerIds.filter((id) => id !== consumer.id);
      });
      consumer.on('producerclose', () => {
        mediaState.consumers.delete(consumer.id);
        mediaState.consumerMeta.delete(consumer.id);
        peer.consumerIds = peer.consumerIds.filter((id) => id !== consumer.id);
        if (fastify.io) {
            fastify.io.to(`user:${req.user.id}`).emit('voice:producer_removed', {
              producerId: consumer.producerId
            });
        }
      });

      return {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      };
    } catch (err) {
      return res.code(500).send({ error: err.message });
    }
  });

  fastify.post('/resume', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'resume')) return;
    const { consumerId } = req.body;
    const consumer = mediaState.consumers.get(consumerId);
    
    if (!consumer) {
      return res.code(404).send({ error: 'Consumer not found' });
    }

    const peer = mediaState.peers.get(req.user.id);
    if (!peer || !peer.consumerIds.includes(consumerId)) {
      return res.code(403).send({ error: 'Consumer does not belong to you' });
    }

    const cMeta = mediaState.consumerMeta.get(consumerId);
    if (cMeta && cMeta.channelId) {
      const check = requireVoiceAccess(cMeta.channelId, req.user.id, res);
      if (!check) return;
    }

    await consumer.resume();
    return { success: true };
  });

  fastify.post('/leave', { preHandler: [authenticate] }, async (req, res) => {
    if (rejectRate(req, res, 'leave')) return;
    cleanupPeer(req.user.id);
    return { success: true };
  });
}
