import { getOrCreateRouter, createWebRtcTransport, mediaState, routers } from '../media/mediasoup.js';

export default async function voiceRoutes(fastify, options) {
  const { authenticate } = options;

  fastify.post('/join', { preHandler: [authenticate] }, async (req, res) => {
    const { channel_id } = req.body;
    
    if (!channel_id) return res.code(400).send({ error: 'Missing channel_id' });

    // Ensure user has connect rights (to be implemented via permission service, assuming yes for now)
    const router = await getOrCreateRouter(channel_id);

    return {
      routerRtpCapabilities: router.rtpCapabilities
    };
  });

  fastify.post('/transport/create', { preHandler: [authenticate] }, async (req, res) => {
    const { channel_id } = req.body;
    if (!channel_id) return res.code(400).send({ error: 'Missing channel_id' });

    const router = await getOrCreateRouter(channel_id);
    const transport = await createWebRtcTransport(router);

    const peer = mediaState.peers.get(req.user.id) || { transportIds: [], producerIds: [], consumerIds: [] };
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
    const { transportId, dtlsParameters } = req.body;
    const transport = mediaState.transports.get(transportId);
    if (!transport) {
      return res.code(404).send({ error: 'Transport not found' });
    }

    try {
      await transport.connect({ dtlsParameters });
      return { success: true };
    } catch (err) {
      return res.code(500).send({ error: err.message });
    }
  });

  fastify.post('/produce', { preHandler: [authenticate] }, async (req, res) => {
    const { transportId, kind, rtpParameters, appData } = req.body;
    
    const transport = mediaState.transports.get(transportId);
    if (!transport) {
      return res.code(404).send({ error: 'Transport not found' });
    }

    try {
      const producer = await transport.produce({ kind, rtpParameters, appData });
      mediaState.producers.set(producer.id, producer);
      
      const peer = mediaState.peers.get(req.user.id);
      if (peer) peer.producerIds.push(producer.id);

      producer.on('transportclose', () => producer.close());

      // Broadcast new producer to room
      if (appData && appData.channel_id && fastify.io) {
        fastify.io.to(`channel:${appData.channel_id}`).emit('voice:producer_added', {
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

  fastify.post('/consume', { preHandler: [authenticate] }, async (req, res) => {
    const { transportId, producerId, rtpCapabilities, channel_id } = req.body;
    
    // Make sure we have the router for the given channel
    const router = routers.get(channel_id);
    if (!router) {
      return res.code(404).send({ error: 'Router not found for channel' });
    }

    const transport = mediaState.transports.get(transportId);
    if (!transport) {
      return res.code(404).send({ error: 'Transport not found' });
    }

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return res.code(400).send({ error: 'Cannot consume' });
    }

    try {
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true // Consumer always starts paused
      });

      mediaState.consumers.set(consumer.id, consumer);
      
      const peer = mediaState.peers.get(req.user.id);
      if (peer) peer.consumerIds.push(consumer.id);

      consumer.on('transportclose', () => consumer.close());
      consumer.on('producerclose', () => {
        consumer.close();
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
    const { consumerId } = req.body;
    const consumer = mediaState.consumers.get(consumerId);
    
    if (!consumer) {
      return res.code(404).send({ error: 'Consumer not found' });
    }

    await consumer.resume();
    return { success: true };
  });

  fastify.post('/leave', { preHandler: [authenticate] }, async (req, res) => {
    const peer = mediaState.peers.get(req.user.id);
    if (!peer) return { success: true };

    // close producers
    peer.producerIds.forEach(id => {
      const prod = mediaState.producers.get(id);
      if (prod) prod.close();
      mediaState.producers.delete(id);
    });

    // close consumers
    peer.consumerIds.forEach(id => {
      const cons = mediaState.consumers.get(id);
      if (cons) cons.close();
      mediaState.consumers.delete(id);
    });

    // close transports
    peer.transportIds.forEach(id => {
      const trans = mediaState.transports.get(id);
      if (trans) trans.close();
      mediaState.transports.delete(id);
    });

    mediaState.peers.delete(req.user.id);
    return { success: true };
  });
}
