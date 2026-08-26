// Shared API helpers for two-account E2E flows
export const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:47631';

export async function api(method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

export async function registerUser(tag) {
  const suffix = `${tag}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const email = `${suffix}@e2e.local`;
  const username = `e2e${suffix}`.slice(0, 32);
  const password = 'e2e-password-123';
  const out = await api('POST', '/api/auth/register', null, { email, username, password });
  return { token: out.token, user: out.user, email, password };
}

export async function createGuild(token, name) {
  return api('POST', '/api/guilds', token, { name });
}

export async function createChannel(token, guildId, name) {
  return api('POST', `/api/guilds/${guildId}/channels`, token, { name, type: 0 });
}

export async function createInvite(token, guildId) {
  return api('POST', `/api/guilds/${guildId}/invites`, token, {});
}

export async function joinGuild(token, code) {
  return api('POST', `/api/invites/${code}`, token, {});
}

export async function sendMessage(token, channelId, content) {
  return api('POST', `/api/channels/${channelId}/messages`, token, { content });
}

export async function setGuildSettings(token, guildId, settings) {
  return api('PATCH', `/api/users/@me/guilds/${guildId}/settings`, token, settings);
}

export async function getReadStates(token) {
  return api('GET', '/api/users/@me/read-states', token);
}
