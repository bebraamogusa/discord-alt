import * as API from '/api.js';
import { t } from '/i18n.js';
import { S } from './state.js';
import { $, normalizeMe } from './utils.js';

let logoutInProgress = false;
let mfaTicket = null;

async function bootApp() {
  const app = await import('../app.js');
  return app.bootApp();
}

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
  if (view !== 'mfa') mfaTicket = null;
  $('auth-mfa')?.classList.toggle('hidden', view !== 'mfa');
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
    if (data.mfa && data.ticket) {
      mfaTicket = data.ticket;
      showAuth('mfa');
      $('mfa-code')?.focus();
      return;
    }
    API.setToken(data.token);
    logoutInProgress = false;
    S.me = normalizeMe(data.user);
    hideAuth();
    await bootApp();
  } catch (e) {
    $('auth-login-err').textContent = e.body?.error || t('login_error');
  }
}

export async function doMfaLogin() {
  const error = $('auth-mfa-err');
  if (error) error.textContent = '';
  const code = $('mfa-code')?.value.trim() || '';
  if (!mfaTicket || !code) {
    if (error) error.textContent = t('fill_fields');
    return;
  }
  try {
    const data = await API.post('/api/auth/mfa/totp', { ticket: mfaTicket, code });
    API.setToken(data.token);
    mfaTicket = null;
    logoutInProgress = false;
    S.me = normalizeMe(data.user);
    hideAuth();
    await bootApp();
  } catch (e) {
    if (error) error.textContent = e.body?.error || t('login_error');
  }
}

export function cancelMfaLogin() {
  mfaTicket = null;
  const code = $('mfa-code');
  if (code) code.value = '';
  showAuth('login');
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
    logoutInProgress = false;
    S.me = normalizeMe(data.user);
    hideAuth();
    await bootApp();
  } catch (e) {
    $('auth-reg-err').textContent = e.body?.error || t('register_error');
  }
}

export function doLogout(socket) {
  if (logoutInProgress) return;
  logoutInProgress = true;
  API.clearTokens();
  const serverLogout = API.logout();
  const activeSocket = socket && typeof socket.disconnect === 'function'
    ? socket
    : (typeof window !== 'undefined' ? window.socket : null);
  if (activeSocket && typeof activeSocket.disconnect === 'function') activeSocket.disconnect();
  Object.assign(S, { me: null, servers: [], dmChannels: [], activeServerId: null, activeChannelId: null });
  showAuth('login');
  serverLogout.catch(() => { });
}
