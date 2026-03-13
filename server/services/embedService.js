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

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function isMediaType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/');
}

export function buildEmbedService() {
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
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
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
        if (bytes > maxHtmlBytes) break;
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
    getLinkPreview,
    generateEmbedsFromContent,
  };
}
