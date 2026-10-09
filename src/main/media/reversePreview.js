// Reversed preview files. Browsers can't play video backwards, so for a
// reversed clip the preview plays a small file of that clip rendered backwards.
// It is made by the real exporter from a one-clip project, so the preview shows
// exactly what the export will. Files are cached by source, trim points and fps.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startExport } from '../export/export.js';
import { createProject } from '../../shared/schema.js';

const PREVIEW_HEIGHT = 360;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * A request: { source, name, duration, hasVideo, hasAudio, audioChannels, width,
 * height, in, out, fps, video, audio } — `video`/`audio` say which parts to render.
 */
function miniProject(req) {
  const settings = req.video
    ? { height: PREVIEW_HEIGHT, width: even((PREVIEW_HEIGHT * req.width) / req.height), fps: req.fps }
    : { width: 160, height: 90, fps: req.fps };
  const p = createProject(settings);
  p.media.push({
    id: 'm', path: req.source, name: req.name, duration: req.duration,
    hasVideo: req.hasVideo, hasAudio: req.hasAudio, audioChannels: req.audioChannels,
  });
  const timing = { mediaId: 'm', start: 0, in: req.in, out: req.out, effects: [{ type: 'reverse' }] };
  const linkId = req.video && req.audio ? 'l' : undefined;
  if (req.video) p.tracks.find((t) => t.id === 'v1').clips.push({ id: 'v', ...timing, linkId });
  if (req.audio) {
    p.tracks.find((t) => t.id === 'a1').clips.push({
      id: 'a', ...timing, linkId, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
    });
  }
  return p;
}

export class ReversePreviews {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.inFlight = new Map(); // file -> promise
    this.queue = Promise.resolve(); // one render at a time
  }

  /** Path of the reversed preview for a request; renders it if needed. */
  get(req) {
    const key = JSON.stringify([req.source, req.in, req.out, req.fps, req.video, req.audio]);
    const file = path.join(this.cacheDir, `reverse-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.mp4`);
    if (!this.inFlight.has(file)) {
      const job = this.queue.then(() => this.render(req, file));
      this.queue = job.catch(() => {});
      this.inFlight.set(file, job);
      job.catch(() => this.inFlight.delete(file)); // allow a retry after a failure
    }
    return this.inFlight.get(file);
  }

  async render(req, file) {
    if (await fs.access(file).then(() => true, () => false)) return file;
    await fs.mkdir(this.cacheDir, { recursive: true });
    const tmp = `${file}.part.mp4`;
    await startExport(miniProject(req), tmp, { quality: 'draft', keyint: 15 }).promise;
    await fs.rename(tmp, file);
    return file;
  }
}
