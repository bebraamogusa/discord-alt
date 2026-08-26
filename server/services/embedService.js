import dns from 'node:dns/promises';
import net from 'node:net';

const URL_RE = /https?:\/\/[^\s<>{}"'`]+/gi;

function stripMetaContent(input) {
  return String(input || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripMetaContent(match[1]);
  }
  return '';
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? stripMetaContent(match[1]) : '';
}

function ipv4ToNumber(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;

  if (net.isIPv4(host)) {
    const ip = ipv4ToNumber(host);
    return ip === null || ip < 0x01000000 || ip >= 0xE0000000 ||
      (ip >= 0x0A000000 && ip <= 0x0AFFFFFF) ||
      (ip >= 0x64400000 && ip <= 0x647FFFFF) ||
      (ip >= 0x7F000000 && ip <= 0x7FFFFFFF) ||
      (ip >= 0xA9FE0000 && ip <= 0xA9FEFFFF) ||
      (ip >= 0xAC100000 && ip <= 0xAC1FFFFF) ||
      (ip >= 0xC0000000 && ip <= 0xC00000FF) ||
      (ip >= 0xC0000200 && ip <= 0xC00002FF) ||
      (ip >= 0xC0586300 && ip <= 0xC05863FF) ||
      (ip >= 0xC0A80000 && ip <= 0xC0A8FFFF) ||
      (ip >= 0xC6120000 && ip <= 0xC613FFFF) ||
      (ip >= 0xC6336400 && ip <= 0xC63364FF) ||
      (ip >= 0xCB007100 && ip <= 0xCB0071FF);
  }

  if (net.isIPv6(host)) {
    const normalized = host.split('%')[0];
    const groups = normalized.split(':');
    const expanded = [];
    const gap = groups.indexOf('');
    if (gap >= 0) {
      const left = groups.slice(0, gap).filter(Boolean);
      const right = groups.slice(gap + 1).filter(Boolean);
      expanded.push(...left, ...Array(8 - left.length - right.length).fill('0'), ...right);
    } else expanded.push(...groups);
    if (expanded.length !== 8) return true;
    const values = expanded.map((part) => Number.parseInt(part || '0', 16));
    const first = values[0];
    const second = values[1];
    const mappedIpv4 = values[5] === 0xFFFF
      ? `${values[6] >> 8}.${values[6] & 0xFF}.${values[7] >> 8}.${values[7] & 0xFF}`
      : '';
    return values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xFFFF) &&
      (values.every((value) => value === 0) || (values.slice(0, 7).every((value) => value === 0) && values[7] <= 1) ||
        (first & 0xFE00) === 0xFC00 || (first & 0xFFC0) === 0xFE80 || (first & 0xFF00) === 0xFF00 ||
        (first === 0x2001 && second === 0x0DB8) || (first === 0x2001 && (second & 0xFFF0) === 0x0010) ||
        (first === 0x2001 && second === 0x0002) || (first === 0x2001 && (second & 0xFE00) === 0x0200) ||
        (values.slice(0, 5).every((value) => value === 0) && values[5] === 0xFFFF && isPrivateHost(mappedIpv4)));
  }

  return false;
}

function isMediaType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/');
}

export function buildEmbedService({ fetchImpl = fetch, lookup = dns.lookup } = {}) {
  const cache = new Map();
  const cacheTtlMs = 60 * 60 * 1000;
  const maxHtmlBytes = 1024 * 1024;

  function getCached(key) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      cache.delete(key);
      return null;
    }
    return cached.value;
  }

  function setCached(key, value) {
    cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
    return value;
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      if (!['http:', 'https:'].includes(u.protocol)) return null;
      if (isPrivateHost(u.hostname)) return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  async function assertPublicHost(url) {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isPrivateHost(host)) throw new Error('private host');
    if (net.isIP(host)) return;
    const records = await lookup(host, { all: true, verbatim: true });
    const addresses = Array.isArray(records) ? records : [records];
    if (!addresses.length || addresses.some((record) => isPrivateHost(record.address || record))) throw new Error('private address');
  }

  async function fetchPublic(url, options = {}) {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await assertPublicHost(current);
      const response = await fetchImpl(current, { ...options, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location || redirects === 5) return { ok: false, status: 502 };
      const next = normalizeUrl(new URL(location, current).toString());
      if (!next) return { ok: false, status: 502 };
      current = next;
    }
    return { ok: false, status: 502 };
  }

  function extractUrls(text) {
    const unique = new Set();
    for (const raw of String(text || '').match(URL_RE) || []) {
      const normalized = normalizeUrl(raw);
      if (normalized) unique.add(normalized);
      if (unique.size >= 3) break;
    }
    return [...unique];
  }

  async function fetchTextLimited(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchPublic(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'user-agent': 'DiscordAltBot/1.0 (+self-hosted)',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
      });
      if (!response.ok) return { ok: false };
      const ct = String(response.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('text/html')) {
        return { ok: true, contentType: ct, html: '' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { ok: false };
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxHtmlBytes) {
          await reader.cancel();
          return { ok: false };
        }
        chunks.push(value);
      }
      const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      return { ok: true, contentType: ct, html };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getLinkPreview(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;

    const fromCache = getCached(normalized);
    if (fromCache) return fromCache;

    const result = await fetchTextLimited(normalized);
    if (!result.ok) return null;

    const contentType = String(result.contentType || '').toLowerCase();

    if (isMediaType(contentType)) {
      const media = {
        url: normalized,
        title: '',
        description: '',
        siteName: new URL(normalized).hostname,
        image: contentType.startsWith('image/') ? `/api/proxy/image?url=${encodeURIComponent(normalized)}` : '',
      };
      return setCached(normalized, media);
    }

    const html = result.html || '';
    if (!html) return null;

    const title = extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title') || extractTitle(html);
    const description = extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description') || extractMeta(html, 'description');
    const siteName = extractMeta(html, 'og:site_name') || new URL(normalized).hostname;

    const imageRaw = extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image');
    const imageUrl = normalizeUrl(imageRaw);

    const preview = {
      url: normalized,
      title: title || '',
      description: description || '',
      siteName: siteName || '',
      image: imageUrl ? `/api/proxy/image?url=${encodeURIComponent(imageUrl)}` : '',
    };

    if (!preview.title && !preview.description && !preview.image) {
      return setCached(normalized, null);
    }

    return setCached(normalized, preview);
  }

  async function generateEmbedsFromContent(content) {
    const urls = extractUrls(content);
    if (!urls.length) return [];
    const previews = await Promise.all(urls.map((url) => getLinkPreview(url)));
    return previews.filter(Boolean).map((p) => ({
      type: 'link',
      url: p.url,
      title: p.title,
      description: p.description,
      provider: p.siteName,
      image: p.image,
    }));
  }

  return {
    normalizeUrl,
    fetchPublic,
    getLinkPreview,
    generateEmbedsFromContent,
  };
}
