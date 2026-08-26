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
  readStates: {},            // channelId -> last_read_message_id
  guildSettings: {},         // guildId -> notification settings
  guildEvents: {},           // guildId -> scheduled events list
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
  stream: null,             // local mic MediaStream
  screenStream: null,       // local screen share MediaStream
  screenTrack: null,        // local screen video track
  isScreenSharing: false,
  remoteStreams: new Map(), // userId -> remote screen MediaStream
};
