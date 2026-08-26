import * as mediasoup from 'mediasoup';
import os from 'os';

let workers = [];
let nextWorkerIndex = 0;

export const routers = new Map();

export const mediaState = {
  transports: new Map(),
  producers: new Map(),
  consumers: new Map(),
  peers: new Map(),
  transportMeta: new Map(),
  producerMeta: new Map(),
  consumerMeta: new Map(),
};

export const voiceLimits = {
  transportsPerUser: 4,
  producersPerUser: 4,
  consumersPerUser: 64,
  transportsPerChannel: 200,
  producersPerChannel: 200,
  consumersPerChannel: 1000,
};

export const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000
    }
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000
    }
  },
  {
    kind: 'video',
    mimeType: 'video/h264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000
    }
  }
];

export async function createWorkers() {
  const numWorkers = Object.keys(os.cpus()).length;
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: parseInt(process.env.MEDIASOUP_RTC_MIN_PORT || '30000'),
      rtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT || '30200')
    });

    worker.on('died', () => {
      console.error(`mediasoup worker died [pid:${worker.pid}] - voice features may be unavailable`);
      workers = workers.filter(w => w !== worker);
    });

    workers.push(worker);
  }
}

function getWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

export async function getOrCreateRouter(channelId) {
  let router = routers.get(channelId);
  if (!router) {
    const worker = getWorker();
    router = await worker.createRouter({ mediaCodecs });
    routers.set(channelId, router);
  }
  return router;
}

export async function createWebRtcTransport(router) {
  const listenIps = [{
    ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1'
  }];

  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000
  });

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'closed' || dtlsState === 'failed') {
      transport.close();
    }
  });

  transport.on('close', () => {
    mediaState.transports.delete(transport.id);
    mediaState.transportMeta.delete(transport.id);
    for (const peer of mediaState.peers.values()) {
      peer.transportIds = peer.transportIds.filter((id) => id !== transport.id);
    }
    cleanupIdleRouters();
  });

  mediaState.transports.set(transport.id, transport);

  return transport;
}

export function cleanupPeer(userId) {
  const peer = mediaState.peers.get(userId);
  if (!peer) return;

  for (const id of peer.producerIds) mediaState.producers.get(id)?.close();
  for (const id of peer.consumerIds) mediaState.consumers.get(id)?.close();
  for (const id of peer.transportIds) mediaState.transports.get(id)?.close();
  mediaState.peers.delete(userId);
  cleanupIdleRouters();
}

export function cleanupIdleRouters() {
  for (const [channelId, router] of routers) {
    const inUse = [...mediaState.transportMeta.values(), ...mediaState.producerMeta.values(), ...mediaState.consumerMeta.values()]
      .some((meta) => meta.channelId === channelId);
    if (!inUse) {
      router.close();
      routers.delete(channelId);
    }
  }
}
