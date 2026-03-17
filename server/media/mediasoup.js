import * as mediasoup from 'mediasoup';
import os from 'os';

let workers = [];
let nextWorkerIndex = 0;

export const routers = new Map();

export const mediaState = {
  transports: new Map(),
  producers: new Map(),
  consumers: new Map(),
  peers: new Map()
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
      rtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT || '32000')
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
    console.log(`Transport closed: ${transport.id}`);
  });

  mediaState.transports.set(transport.id, transport);

  return transport;
}
