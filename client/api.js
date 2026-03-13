/**
 * api.js — Fetch wrapper with auto JWT refresh.
 * Import as ES module: import * as API from '/api.js';
 */

export function getToken()          { return localStorage.getItem('da_token'); }
export function setToken(t)         { localStorage.setItem('da_token', t); }
export function setRefreshToken(rt) { localStorage.setItem('da_refresh', rt); }
export function clearTokens()       { localStorage.removeItem('da_token'); localStorage.removeItem('da_refresh'); }

async function tryRefresh() {
  const res = await fetch('/api/auth/refresh', {
    method:  'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) { clearTokens(); throw new Error('session expired'); }
  const d = await res.json();
  setToken(d.token);
  if (d.refreshToken) setRefreshToken(d.refreshToken);
  return d.token;
}

export async function api(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });

  if (res.status === 401) {
    try {
      const newToken = await tryRefresh();
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    } catch {
      clearTokens();
      window.dispatchEvent(new CustomEvent('da:logout'));
      throw new Error('Unauthorized');
    }
  }

  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return null;
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body?.error || 'Request failed');
    err.statusCode = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const get   = (path, opts)       => api(path, { ...opts, method: 'GET' });
export const post  = (path, body, opts) => api(path, { ...opts, method: 'POST',   body: JSON.stringify(body) });
export const patch = (path, body, opts) => api(path, { ...opts, method: 'PATCH',  body: JSON.stringify(body) });
export const put   = (path, body, opts) => api(path, { ...opts, method: 'PUT',    body: JSON.stringify(body) });
export const del   = (path, opts)       => api(path, { ...opts, method: 'DELETE' });

/** Upload a file; returns { url, name, type } */
export async function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd  = new FormData();
    fd.append('file', file);
    xhr.open('POST', '/api/upload');
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (onProgress) xhr.upload.onprogress = e => onProgress(e.loaded / e.total);
    xhr.onload  = () => {
      try { const d = JSON.parse(xhr.responseText); xhr.status < 400 ? resolve(d) : reject(new Error(d.error)); }
      catch { reject(new Error('Upload error')); }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(fd);
  });
}
