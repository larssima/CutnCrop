// Background preparation of imported media: a thumbnail strip and waveform
// peaks for the timeline, and a low-res proxy (H.264 with short GOPs for fast
// preview seeking, or AAC for audio-only files).
// Files are cached by source path + size + mtime, so re-imports are instant.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runFfmpeg } from '../ffmpeg/run.js';
import { ffmpegPaths } from '../ffmpeg/paths.js';

export const THUMB_TILES = 10;
export const PEAKS_PER_SECOND = 100;
const PEAKS_RATE = 8000;
const PROXY_HEIGHT = 540;

async function cacheKey(srcPath) {
  const st = await fs.stat(srcPath);
  return crypto.createHash('sha1').update(`${srcPath}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

/** Run ffmpeg into a temp name and rename on success so partial files never look done. */
async function produce(outPath, args, opts) {
  const tmp = `${outPath}.part${path.extname(outPath)}`;
  try {
    const job = runFfmpeg([...args, tmp], opts);
    await job.promise;
    await fs.rename(tmp, outPath);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function makeThumbStrip(media, cacheDir) {
  const out = path.join(cacheDir, `${await cacheKey(media.path)}-thumbs.jpg`);
  if (await exists(out)) return out;
  const rate = THUMB_TILES / Math.max(media.duration, 0.1);
  await produce(out, [
    '-i', media.path,
    '-vf', `fps=${rate.toFixed(6)},scale=-2:90,tile=${THUMB_TILES}x1`,
    '-frames:v', '1', '-q:v', '5', '-an',
  ]);
  return out;
}

/**
 * Waveform peaks: one byte (0-255, linear peak level) per 1/PEAKS_PER_SECOND s,
 * from a mono 8 kHz decode streamed through ffmpeg's stdout.
 */
export async function makePeaks(media, cacheDir) {
  const out = path.join(cacheDir, `${await cacheKey(media.path)}-peaks.bin`);
  if (await exists(out)) return out;
  const bucket = PEAKS_RATE / PEAKS_PER_SECOND;
  const peaks = [];
  let current = 0;
  let count = 0;
  let carry = null;

  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPaths().ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', media.path,
      '-vn', '-ac', '1', '-ar', String(PEAKS_RATE), '-f', 's16le', '-',
    ], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.stdout.on('data', (chunk) => {
      if (carry) {
        chunk = Buffer.concat([carry, chunk]);
        carry = null;
      }
      const even = chunk.length - (chunk.length % 2);
      if (even < chunk.length) carry = chunk.subarray(even);
      for (let o = 0; o < even; o += 2) {
        const v = Math.abs(chunk.readInt16LE(o));
        if (v > current) current = v;
        if (++count === bucket) {
          peaks.push(Math.min(255, Math.round((current / 32768) * 255)));
          current = 0;
          count = 0;
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with ${code}`))));
  });
  if (count > 0) peaks.push(Math.min(255, Math.round((current / 32768) * 255)));
  await fs.writeFile(`${out}.part`, Buffer.from(peaks));
  await fs.rename(`${out}.part`, out);
  return out;
}

export async function makeProxy(media, cacheDir, onProgress) {
  if (!media.hasVideo) return makeAudioProxy(media, cacheDir, onProgress);
  const out = path.join(cacheDir, `${await cacheKey(media.path)}-proxy.mp4`);
  if (await exists(out)) return out;
  const audio = media.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : ['-an'];
  await produce(out, [
    '-i', media.path,
    // Keep source timestamps (VFR stays VFR) so proxy times equal source times.
    '-fps_mode', 'passthrough',
    '-vf', `scale=-2:'min(${PROXY_HEIGHT},ih)'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    ...audio,
    '-movflags', '+faststart',
  ], { duration: media.duration, onProgress });
  return out;
}

/** AAC copy of an audio file, for formats Chromium can't play (WMA, AC-3, …). */
async function makeAudioProxy(media, cacheDir, onProgress) {
  const out = path.join(cacheDir, `${await cacheKey(media.path)}-proxy.m4a`);
  if (await exists(out)) return out;
  await produce(out, ['-i', media.path, '-vn', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000'], {
    duration: media.duration,
    onProgress,
  });
  return out;
}

/**
 * Sequential job queue. Thumbnails jump ahead of proxies because they are
 * quick and make the UI useful immediately.
 */
export class MediaPreparer {
  constructor(cacheDir, onUpdate) {
    this.cacheDir = cacheDir;
    this.onUpdate = onUpdate; // (mediaId, patch) => void
    this.queue = [];
    this.running = false;
    this.pending = new Set();
  }

  add(media) {
    if (this.pending.has(media.id)) return;
    this.pending.add(media.id);
    // Quick jobs go to the front so the timeline looks right early.
    if (media.hasAudio) this.queue.unshift({ kind: 'peaks', media });
    if (media.hasVideo) this.queue.unshift({ kind: 'thumbs', media });
    this.queue.push({ kind: 'proxy', media });
    this.pump();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    await fs.mkdir(this.cacheDir, { recursive: true });
    while (this.queue.length) {
      const { kind, media } = this.queue.shift();
      try {
        if (kind === 'thumbs') {
          this.onUpdate(media.id, { thumbPath: await makeThumbStrip(media, this.cacheDir) });
        } else if (kind === 'peaks') {
          this.onUpdate(media.id, { peaksPath: await makePeaks(media, this.cacheDir) });
        } else {
          const proxyPath = await makeProxy(media, this.cacheDir, (p) => this.onUpdate(media.id, { proxyProgress: p }));
          this.onUpdate(media.id, { proxyPath, proxyProgress: 1 });
          this.pending.delete(media.id);
        }
      } catch (e) {
        this.onUpdate(media.id, { error: `${kind} failed: ${e.message}` });
        if (kind === 'proxy') this.pending.delete(media.id);
      }
    }
    this.running = false;
  }
}
