// app state
export const S = {
  me: null,
  servers: [],
  dmChannels: [],
  activeServerId: null,
  activeChannelId: null,
  messages: {},
  members: {},
  presences: {},
  typingUsers: {},
  unread: {},
  replyTo: null,
  membersVisible: true,
  pendingChannelCreate: null,
  voiceStates: {},          // { channelId: [participant, ...] }
  friends: [],              // friend list
  _friendRequestCount: 0,   // pending incoming friend requests
};

// Voice connection state
export const V = {
  channelId: null,          // currently connected channel id
  muted: false,
  deafened: false,
  stream: null,             // local MediaStream
  screenStream: null,       // local screen share stream
  screenTrack: null,        // local screen video track
  isScreenSharing: false,
  peers: new Map(),         // userId → RTCPeerConnection
  audios: new Map(),        // userId → HTMLAudioElement
  remoteStreams: new Map(), // userId → remote MediaStream
  screenSenders: new Map(), // userId → RTCRtpSender (screen video)
};

export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
