import * as API from '/api.js';
import { t } from '/i18n.js';
import { S } from './state.js';
import { $, normalizeMe } from './utils.js';
import { bootApp } from '../app.js';

export function showAuth(view = 'login') {
  $('auth-overlay').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('auth-login').classList.toggle('hidden', view !== 'login');
  $('auth-register').classList.toggle('hidden', view !== 'register');
  // Clear all auth fields to prevent browser from restoring stale values
  ['li-email', 'li-pass', 'reg-email', 'reg-name', 'reg-pass'].forEach(id => {
    const el = $(id); if (el) el.value = '';
  });
  $('auth-login-err').textContent = '';
  $('auth-reg-err').textContent = '';
}

export function hideAuth() {
  $('auth-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
}

export async function doLogin() {
  $('auth-login-err').textContent = '';
  const email = $('li-email').value.trim();
  const password = $('li-pass').value;
  if (!email || !password) { $('auth-login-err').textContent = t('fill_fields'); return; }
  try {
    const data = await API.post('/api/auth/login', { email, password });
    API.setToken(data.token);
    S.me = normalizeMe(data.user);
    await bootApp();
  } catch (e) {
    $('auth-login-err').textContent = e.body?.error || t('login_error');
  }
}

export async function doRegister() {
  $('auth-reg-err').textContent = '';
  const email = $('reg-email').value.trim();
  const username = $('reg-name').value.trim();
  const password = $('reg-pass').value;
  if (!email || !username || !password) { $('auth-reg-err').textContent = t('fill_fields'); return; }
  try {
    const data = await API.post('/api/auth/register', { email, username, password });
    API.setToken(data.token);
    S.me = normalizeMe(data.user);
    await bootApp();
  } catch (e) {
    $('auth-reg-err').textContent = e.body?.error || t('register_error');
  }
}

export function doLogout(socket) {
  API.post('/api/auth/logout', {}).catch(() => { });
  API.clearTokens();
  socket?.disconnect();
  Object.assign(S, { me: null, servers: [], dmChannels: [], activeServerId: null, activeChannelId: null });
  showAuth('login');
}
