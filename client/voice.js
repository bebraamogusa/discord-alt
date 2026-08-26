import * as API from '/api.js';
import { S, V } from './src/state.js';
import { showToast } from './src/utils.js';
import { t } from '/i18n.js';
import { renderVoicePanel, renderVoiceBar } from './src/ui.js';

let device;
let sendTransport;
let recvTransport;
let micStream;
let micTrack;
let audioProducer;
let screenProducer;
let screenStream;
let mediasoupClientLib;
const consumersByProducer = new Map(); // producerId -> consumer

async function loadMediasoupClient() {
  if (mediasoupClientLib) return mediasoupClientLib;
  try {
    mediasoupClientLib = await import('/vendor/mediasoup-client.esm.js');
    if (!mediasoupClientLib.Device && mediasoupClientLib.default) mediasoupClientLib = mediasoupClientLib.default;
  } catch {
    mediasoupClientLib = await import('https://esm.sh/mediasoup-client@3');
  }
  return mediasoupClientLib;
}

function refreshVoiceUi() {
  renderVoicePanel();
  renderVoiceBar();
}

async function createTransport(deviceRef, channelId, direction) {
  const data = await API.post('/api/voice/transport/create', { channel_id: channelId });
  const transport = direction === 'send'
    ? deviceRef.createSendTransport(data)
    : deviceRef.createRecvTransport(data);

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    API.post('/api/voice/transport/connect', { transportId: transport.id, dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  if (direction === 'send') {
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      API.post('/api/voice/produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
        appData: { ...appData, channel_id: channelId },
      }).then(({ id }) => callback({ id })).catch(errback);
    });
  }

  return transport;
}

function playRemoteAudio(producerId, userId, track) {
  const existing = document.querySelector(`audio[data-producer-id="${producerId}"]`);
  if (existing) return;
  const audio = document.createElement('audio');
  audio.dataset.producerId = producerId;
  audio.dataset.userId = userId;
  audio.srcObject = new MediaStream([track]);
  audio.autoplay = true;
  audio.muted = V.deafened;
  document.body.appendChild(audio);
  audio.play?.().catch(() => { });
}

function removeRemoteProducer(producerId) {
  const consumer = consumersByProducer.get(producerId);
  if (consumer) {
    try { consumer.close(); } catch { }
    consumersByProducer.delete(producerId);
  }
  document.querySelectorAll(`audio[data-producer-id="${producerId}"]`).forEach(el => {
    el.srcObject = null;
    el.remove();
  });
  for (const [userId, stream] of V.remoteStreams) {
    const stillLive = stream.getTracks().some(track => track.readyState === 'live');
    if (!stillLive) V.remoteStreams.delete(userId);
  }
}

async function consumeProducer(producerId, userId, kind) {
  if (!device || !recvTransport || !V.channelId) return;
  if (consumersByProducer.has(producerId)) return;
  if (userId === S.me?.id) return;
  try {
    const data = await API.post('/api/voice/consume', {
      transportId: recvTransport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
      channel_id: V.channelId,
    });
    const consumer = await recvTransport.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });
    consumersByProducer.set(producerId, consumer);
    API.post('/api/voice/resume', { consumerId: consumer.id }).catch(() => { });
    if (data.kind === 'video') {
      let stream = V.remoteStreams.get(userId);
      if (!stream) {
        stream = new MediaStream();
        V.remoteStreams.set(userId, stream);
      }
      stream.addTrack(consumer.track);
    } else {
      playRemoteAudio(producerId, userId, consumer.track);
    }
    refreshVoiceUi();
  } catch (err) {
    console.warn('[voice] consume failed:', err?.body?.error || err?.message || err);
  }
}

export async function handleProducerAdded({ producerId, user_id: userId, kind } = {}) {
  if (!producerId || !V.channelId) return;
  await consumeProducer(producerId, userId, kind);
}

export function handleProducerRemoved(producerId) {
  if (!producerId) return;
  removeRemoteProducer(producerId);
  refreshVoiceUi();
}

export function consumeExistingProducers(producers = []) {
  for (const item of producers) {
    void consumeProducer(item.producerId, item.user_id, item.kind);
  }
}

function emitVoiceState(payload) {
  window.socket?.emit('VOICE_MUTE', payload);
}

function hasAnyMedia() {
  return !!(micStream || screenStream || sendTransport || recvTransport || device ||
    audioProducer || screenProducer || consumersByProducer.size > 0);
}

async function teardownMedia() {
  try { screenProducer?.close(); } catch { }
  screenProducer = undefined;
  try { audioProducer?.close(); } catch { }
  audioProducer = undefined;
  for (const consumer of consumersByProducer.values()) {
    try { consumer.close(); } catch { }
  }
  consumersByProducer.clear();
  try { sendTransport?.close(); } catch { }
  try { recvTransport?.close(); } catch { }
  sendTransport = undefined;
  recvTransport = undefined;
  try { device?.close(); } catch { }
  device = undefined;
  if (micStream) for (const track of micStream.getTracks()) track.stop();
  micStream = undefined;
  micTrack = undefined;
  if (screenStream) for (const track of screenStream.getTracks()) track.stop();
  screenStream = undefined;
  document.querySelectorAll('audio[data-producer-id]').forEach(el => {
    el.srcObject = null;
    el.remove();
  });
  V.remoteStreams.clear();
}

export async function joinVoiceChannel(channelId) {
  if (!channelId) return false;
  if (V.channelId === channelId) return true;
  if (V.channelId) await leaveVoiceChannel();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micTrack = micStream.getAudioTracks()[0] || null;

    const { routerRtpCapabilities } = await API.post('/api/voice/join', { channel_id: channelId });
    const lib = await loadMediasoupClient();
    device = new lib.Device();
    await device.load({ routerRtpCapabilities });

    sendTransport = await createTransport(device, channelId, 'send');
    recvTransport = await createTransport(device, channelId, 'recv');
    V.channelId = channelId;

    if (micTrack) {
      audioProducer = await sendTransport.produce({ track: micTrack, appData: { channel_id: channelId } });
      if (V.muted) await audioProducer.pause().catch(() => { });
    }

    V.stream = micStream;
    window.socket?.emit('VOICE_JOIN', { channel_id: channelId });
    refreshVoiceUi();
    return true;
  } catch (err) {
    console.warn('[voice] join failed:', err?.name || err?.message || err);
    await teardownMedia();
    V.channelId = null;
    V.stream = null;
    if (err?.name === 'NotAllowedError' || err?.name === 'NotFoundError') {
      showToast(t('voice_no_mic'), 'error');
    } else {
      showToast(t('error_generic'), 'error');
    }
    return false;
  }
}

export async function leaveVoiceChannel(opts = {}) {
  const wasConnected = !!V.channelId || hasAnyMedia();
  V.channelId = null;
  V.stream = null;
  V.screenStream = null;
  V.screenTrack = null;
  V.isScreenSharing = false;
  V.muted = false;
  V.deafened = false;
  await teardownMedia();
  if (wasConnected && !opts.localOnly) {
    window.socket?.emit('VOICE_LEAVE');
    API.post('/api/voice/leave').catch(() => { });
  }
  refreshVoiceUi();
}

export function handleGatewayDisconnect() {
  if (!V.channelId) return;
  void leaveVoiceChannel({ localOnly: true });
}

export async function toggleMute() {
  if (!V.channelId) return;
  const next = !V.muted;
  try {
    if (audioProducer) {
      if (next) await audioProducer.pause();
      else await audioProducer.resume();
    } else if (micTrack) {
      micTrack.enabled = !next;
    }
  } catch {
    showToast(t('error_generic'), 'error');
    return;
  }
  V.muted = next;
  emitVoiceState({ muted: next });
  refreshVoiceUi();
}

export async function toggleDeafen() {
  if (!V.channelId) return;
  V.deafened = !V.deafened;
  document.querySelectorAll('audio[data-producer-id]').forEach(el => { el.muted = V.deafened; });
  emitVoiceState({ deafened: V.deafened });
  refreshVoiceUi();
}

export async function startScreenShare() {
  if (!sendTransport || V.isScreenSharing) return false;
  let screen;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    console.warn('[voice] screen share denied:', err?.name || err?.message || err);
    showToast(t('voice_screen_failed'), 'error');
    return false;
  }
  const track = screen.getVideoTracks()[0];
  if (!track) {
    screen.getTracks().forEach(item => item.stop());
    return false;
  }
  try {
    screenProducer = await sendTransport.produce({ track, appData: { channel_id: V.channelId, source: 'screen' } });
  } catch (err) {
    console.warn('[voice] screen produce failed:', err?.message || err);
    screen.getTracks().forEach(item => item.stop());
    showToast(t('voice_screen_failed'), 'error');
    return false;
  }
  screenStream = screen;
  V.screenStream = screen;
  V.screenTrack = track;
  V.isScreenSharing = true;
  track.addEventListener('ended', () => { void stopScreenShare(); });
  window.socket?.emit('VOICE_SCREEN', { sharing: true });
  showToast(t('voice_screen_started'), 'success');
  refreshVoiceUi();
  return true;
}

export async function stopScreenShare() {
  if (!V.isScreenSharing && !screenProducer) return;
  if (screenProducer) {
    try { await API.post('/api/voice/producers/close', { producerId: screenProducer.id }); } catch { }
    try { screenProducer.close(); } catch { }
    screenProducer = undefined;
  }
  if (screenStream) for (const track of screenStream.getTracks()) track.stop();
  screenStream = undefined;
  V.screenStream = null;
  V.screenTrack = null;
  V.isScreenSharing = false;
  window.socket?.emit('VOICE_SCREEN', { sharing: false });
  showToast(t('voice_screen_stopped'), 'info');
  refreshVoiceUi();
}

export async function toggleScreenShare() {
  if (V.isScreenSharing) await stopScreenShare();
  else await startScreenShare();
}

export function debugState() {
  return {
    connected: !!V.channelId,
    channelId: V.channelId,
    muted: V.muted,
    deafened: V.deafened,
    screenSharing: V.isScreenSharing,
    audioProducerPaused: audioProducer ? !!audioProducer.paused : null,
    producerCount: (audioProducer ? 1 : 0) + (screenProducer ? 1 : 0),
    consumerCount: consumersByProducer.size,
    audioElementCount: document.querySelectorAll('audio[data-producer-id]').length,
    liveMicTracks: micStream ? micStream.getAudioTracks().filter(track => track.readyState === 'live').length : 0,
    liveScreenTracks: screenStream ? screenStream.getVideoTracks().filter(track => track.readyState === 'live').length : 0,
  };
}
