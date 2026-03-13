import * as API from '/api.js';

let device;
let sendTransport;
let recvTransport;
let audioProducer;
let videoProducer;
let consumers = new Map(); // id -> consumer

// Assume mediasoupClient is injected via script tag or imported
import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

export async function joinVoiceChannel(channelId) {
  try {
    // 1. Get Router RTP Capabilities
    const { routerRtpCapabilities } = await API.post('/api/voice/join', { channel_id: channelId });
    
    // 2. Init device
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities });
    
    // 3. Create Send Transport
    const sendTransportData = await API.post('/api/voice/transport/create', { channel_id: channelId });
    sendTransport = device.createSendTransport(sendTransportData);
    
    sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await API.post('/api/voice/transport/connect', {
          transportId: sendTransport.id,
          dtlsParameters
        });
        callback();
      } catch (err) {
        errback(err);
      }
    });

    sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const { id } = await API.post('/api/voice/produce', {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          appData: { ...appData, channel_id: channelId }
        });
        callback({ id });
      } catch (err) {
        errback(err);
      }
    });

    // 4. Create Receive Transport
    const recvTransportData = await API.post('/api/voice/transport/create', { channel_id: channelId });
    recvTransport = device.createRecvTransport(recvTransportData);
    
    recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await API.post('/api/voice/transport/connect', {
          transportId: recvTransport.id,
          dtlsParameters
        });
        callback();
      } catch (err) {
        errback(err);
      }
    });

    return true;
  } catch (error) {
    console.error('Error joining voice:', error);
    return false;
  }
}

export async function produceAudio(audioTrack) {
  if (!sendTransport) return null;
  audioProducer = await sendTransport.produce({ track: audioTrack });
  return audioProducer;
}

export async function produceVideo(videoTrack) {
  if (!sendTransport) return null;
  videoProducer = await sendTransport.produce({ track: videoTrack });
  return videoProducer;
}

export async function consumeTrack(producerId, channelId) {
  if (!recvTransport) return null;
  
  try {
    const data = await API.post('/api/voice/consume', {
      transportId: recvTransport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
      channel_id: channelId
    });
    
    const consumer = await recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters
    });
    
    consumers.set(consumer.id, consumer);
    
    // Resume consumer on server
    await API.post('/api/voice/resume', { consumerId: consumer.id });
    
    return consumer;
  } catch (error) {
    console.error('Consume track error:', error);
    return null;
  }
}

export async function leaveVoiceChannel() {
  await API.post('/api/voice/leave');
  
  if (sendTransport) sendTransport.close();
  if (recvTransport) recvTransport.close();
  if (audioProducer) audioProducer.close();
  if (videoProducer) videoProducer.close();
  
  consumers.forEach(consumer => consumer.close());
  consumers.clear();
  
  device = null;
}
