import path from 'path';
import { mkdir, readFile, rename, stat, copyFile, unlink, writeFile } from 'fs/promises';
import { spawn } from 'child_process';

function sanitizeFilename(name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}

function extToMime(ext, fallback = 'application/octet-stream') {
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.json': 'application/json',
  };
  return map[String(ext || '').toLowerCase()] || fallback;
}

function toPublicPath(relPath) {
  return `/files/${relPath.replaceAll('\\\\', '/')}`;
}

function tryPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < pngSig.length; i += 1) {
    if (buffer[i] !== pngSig[i]) return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function tryGifDimensions(buffer) {
  if (buffer.length < 10) return null;
  const header = buffer.subarray(0, 6).toString('ascii');
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function tryJpegDimensions(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 4 >= buffer.length) break;
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2) break;
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    if (sofMarkers.has(marker) && offset + 9 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += size + 2;
  }
  return null;
}

function tryWebpDimensions(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType === 'VP8X' && buffer.length >= 30) {
    const w = 1 + buffer.readUIntLE(24, 3);
    const h = 1 + buffer.readUIntLE(27, 3);
    return { width: w, height: h };
  }
  if (chunkType === 'VP8 ' && buffer.length >= 30) {
    const start = 20;
    if (buffer[start + 3] === 0x9d && buffer[start + 4] === 0x01 && buffer[start + 5] === 0x2a) {
      return {
        width: buffer.readUInt16LE(start + 6) & 0x3fff,
        height: buffer.readUInt16LE(start + 8) & 0x3fff,
      };
    }
  }
  if (chunkType === 'VP8L' && buffer.length >= 25) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  return null;
}

function extractImageDimensions(buffer) {
  return tryPngDimensions(buffer) || tryGifDimensions(buffer) || tryJpegDimensions(buffer) || tryWebpDimensions(buffer);
}

function runProcess(command, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill('SIGKILL');
        resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\nTimeout` });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function probeMedia(filePath) {
  const result = await runProcess('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], 8000);

  if (!result.ok || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const format = parsed.format || {};
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    const formatDuration = Number.parseFloat(format.duration || '');
    const streamDuration = Number.parseFloat(video?.duration || audio?.duration || '');
    const duration = Number.isFinite(formatDuration)
      ? formatDuration
      : Number.isFinite(streamDuration)
        ? streamDuration
        : null;

    return {
      duration,
      width: Number.isFinite(Number(video?.width)) ? Number(video.width) : null,
      height: Number.isFinite(Number(video?.height)) ? Number(video.height) : null,
      hasVideo: !!video,
      hasAudio: !!audio,
    };
  } catch {
    return null;
  }
}

async function makeVideoThumbnail(inputPath, outputPath) {
  const result = await runProcess('ffmpeg', [
    '-y',
    '-ss', '00:00:01',
    '-i', inputPath,
    '-vframes', '1',
    '-vf', 'scale=400:-1:force_original_aspect_ratio=decrease',
    outputPath,
  ], 12000);
  return result.ok;
}

function generateWaveformBase64(buffer, bars = 64) {
  if (!buffer || buffer.length === 0) return null;
  const out = new Uint8Array(bars);
  const chunk = Math.max(1, Math.floor(buffer.length / bars));
  for (let i = 0; i < bars; i += 1) {
    const start = i * chunk;
    const end = Math.min(buffer.length, start + chunk);
    let acc = 0;
    for (let j = start; j < end; j += 1) {
      acc += Math.abs(buffer[j] - 128);
    }
    const mean = end > start ? acc / (end - start) : 0;
    out[i] = Math.min(255, Math.round((mean / 128) * 255));
  }
  return Buffer.from(out).toString('base64');
}

export function buildFileService({ uploadsRoot, snowflake }) {
  async function moveFileSafe(src, dest) {
    try {
      await rename(src, dest);
      return;
    } catch {
      await copyFile(src, dest);
      await unlink(src);
    }
  }

  function parseTempAttachmentUrl(url, userId) {
    const prefix = `/files/attachments/temp/${userId}/`;
    if (!String(url || '').startsWith(prefix)) return null;
    const fileName = String(url).slice(prefix.length);
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) return null;
    const relPath = path.join('attachments', 'temp', String(userId), fileName);
    return {
      fileName,
      relPath,
      absPath: path.join(uploadsRoot, relPath),
    };
  }

  async function uploadTempFile({ userId, file }) {
    const fileId = snowflake.generate();
    const safeOriginalName = sanitizeFilename(file.filename || `file_${fileId}`);
    const ext = path.extname(safeOriginalName).toLowerCase();
    const storageName = `${fileId}${ext}`;
    const relDir = path.join('attachments', 'temp', String(userId));
    const absDir = path.join(uploadsRoot, relDir);
    const absPath = path.join(absDir, storageName);

    await mkdir(absDir, { recursive: true });
    const buffer = await file.toBuffer();
    if (buffer.byteLength > 25 * 1024 * 1024) {
      const err = new Error('File is too large');
      err.statusCode = 413;
      throw err;
    }
    await writeFile(absPath, buffer);

    return {
      id: fileId,
      url: toPublicPath(path.join(relDir, storageName)),
      filename: safeOriginalName,
      mime_type: file.mimetype || extToMime(ext),
      size: buffer.byteLength,
    };
  }

  async function finalizeTempAttachment({ userId, channelId, messageId, attachment }) {
    const parsed = parseTempAttachmentUrl(attachment.url, userId);
    if (!parsed) {
      const err = new Error('Invalid attachment URL');
      err.statusCode = 400;
      throw err;
    }

    await stat(parsed.absPath);

    const safeOriginal = sanitizeFilename(attachment.filename || parsed.fileName);
    const ext = path.extname(safeOriginal).toLowerCase() || path.extname(parsed.fileName).toLowerCase();
    const targetFile = `${snowflake.generate()}_${sanitizeFilename(path.basename(safeOriginal, path.extname(safeOriginal)))}${ext}`;

    const relDir = path.join('attachments', String(channelId), String(messageId));
    const absDir = path.join(uploadsRoot, relDir);
    const relPath = path.join(relDir, targetFile);
    const absPath = path.join(uploadsRoot, relPath);

    await mkdir(absDir, { recursive: true });
    await moveFileSafe(parsed.absPath, absPath);

    const fileStat = await stat(absPath);
    if (fileStat.size > 25 * 1024 * 1024) {
      const err = new Error('Attachment exceeds max size');
      err.statusCode = 413;
      throw err;
    }

    const mime = attachment.mime_type || extToMime(ext);

    let width = null;
    let height = null;
    let durationSecs = null;
    let waveform = null;
    let proxyUrl = null;

    if (mime.startsWith('image/')) {
      try {
        const data = await readFile(absPath);
        const dims = extractImageDimensions(data);
        width = dims?.width ?? null;
        height = dims?.height ?? null;
      } catch {
        width = null;
        height = null;
      }
    }

    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      const media = await probeMedia(absPath);
      if (media) {
        durationSecs = media.duration;
        if (media.width && media.height) {
          width = media.width;
          height = media.height;
        }
      }
    }

    if (mime.startsWith('video/')) {
      const thumbName = `${path.basename(targetFile, ext)}_thumb.jpg`;
      const thumbRelPath = path.join(relDir, thumbName);
      const thumbAbsPath = path.join(uploadsRoot, thumbRelPath);
      const ok = await makeVideoThumbnail(absPath, thumbAbsPath);
      if (ok) proxyUrl = toPublicPath(thumbRelPath);
    }

    const isVoiceMessage = (Number(attachment.flags || 0) & 2) === 2;
    if (isVoiceMessage && mime.startsWith('audio/')) {
      try {
        const data = await readFile(absPath);
        waveform = generateWaveformBase64(data);
      } catch {
        waveform = null;
      }
    }

    return {
      id: snowflake.generate(),
      message_id: messageId,
      filename: targetFile,
      original_filename: safeOriginal,
      content_type: mime,
      size: fileStat.size,
      url: toPublicPath(relPath),
      proxy_url: proxyUrl,
      width,
      height,
      duration_secs: durationSecs,
      waveform,
      description: attachment.description || null,
      spoiler: attachment.spoiler ? 1 : 0,
      flags: attachment.flags || 0,
    };
  }

  return {
    uploadTempFile,
    finalizeTempAttachment,
  };
}
