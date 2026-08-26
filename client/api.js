/**
 * api.js — Fetch wrapper with auto JWT refresh.
 * Import as ES module: import * as API from '/api.js';
 */

export const PRODUCTION_SERVER_URL = 'https://lolihentai.online';

export function getServerUrl() {
  if (typeof window !== 'undefined' && window.__API_SERVER_URL__) return window.__API_SERVER_URL__;
  return PRODUCTION_SERVER_URL;
}

function apiOrigin() {
  return new URL(getServerUrl()).origin;
}

export function resolveUrl(path) {
  if (!path) return '';
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${getServerUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function getToken()          { return localStorage.getItem('da_token'); }
export function setToken(t)         { localStorage.setItem('da_token', t); }
export function setRefreshToken(rt) { localStorage.setItem('da_refresh', rt); }
export function clearTokens()       { localStorage.removeItem('da_token'); localStorage.removeItem('da_refresh'); }

export async function logout() {
  const res = await fetch(`${getServerUrl()}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('logout request failed');
  return res.status === 204 ? null : res.json();
}

async function tryRefresh() {
  const res = await fetch(`${getServerUrl()}/api/auth/refresh`, {
    method:  'POST',
    credentials: 'include',
  });
  if (!res.ok) { clearTokens(); throw new Error('session expired'); }
  const d = await res.json();
  setToken(d.token);
  if (d.refreshToken) setRefreshToken(d.refreshToken);
  return d.token;
}

function fileUrl(path) {
  const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path, getServerUrl());
  if (url.origin !== apiOrigin() || !url.pathname.startsWith('/files/')) {
    throw new Error('Invalid protected file URL');
  }
  return url;
}

export async function fetchProtectedFile(path) {
  const url = fileUrl(path);
  const headers = {};
  const request = async () => {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else delete headers.Authorization;
    return fetch(url, { headers, credentials: 'include' });
  };

  let res = await request();
  if (res.status === 401) {
    try {
      await tryRefresh();
      res = await request();
    } catch {
      clearTokens();
      window.dispatchEvent(new CustomEvent('da:logout'));
      throw new Error('Unauthorized');
    }
  }
  if (!res.ok) {
    const err = new Error('Could not load attachment');
    err.statusCode = res.status;
    throw err;
  }
  return URL.createObjectURL(await res.blob());
}

export async function api(path, opts = {}) {
  const url = /^https?:\/\//i.test(path) ? new URL(path).toString() : `${getServerUrl()}${path}`;
  if (new URL(url).origin !== apiOrigin()) throw new Error('Requests must target the configured server');
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res = await fetch(url, { ...opts, headers, credentials: 'include' });

  if (res.status === 401) {
    try {
      const newToken = await tryRefresh();
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(url, { ...opts, headers, credentials: 'include' });
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
    xhr.open('POST', `${getServerUrl()}/api/upload`);
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
