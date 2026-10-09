// Reversed preview files (see main/media/reversePreview.js), requested on demand
// and cached per clip span. reversedFileFor() returns the file once it exists
// and otherwise starts making it; store emits 'reverse-ready' when one arrives.

import { store } from './store.js';
import { findMedia } from '../../shared/timeline.js';

const files = new Map(); // request key -> { status: 'pending' | 'ready' | 'error', path }

/**
 * @param {object} clip  the reversed clip
 * @param {{ video: boolean, audio: boolean }} parts  which parts to render
 */
export function reversedFileFor(clip, parts) {
  const project = store.project;
  const media = findMedia(project, clip.mediaId);
  if (!media) return null;
  const source = media.proxyPath ?? media.path; // proxies render much faster
  const req = {
    source,
    name: media.name,
    duration: media.duration,
    hasVideo: media.hasVideo,
    hasAudio: media.hasAudio,
    audioChannels: media.proxyPath ? 2 : media.audioChannels,
    width: media.width,
    height: media.height,
    in: clip.in,
    out: clip.out,
    fps: project.settings.fps,
    video: parts.video && media.hasVideo,
    audio: parts.audio && media.hasAudio,
  };
  const key = JSON.stringify([req.source, req.in, req.out, req.fps, req.video, req.audio]);
  const entry = files.get(key);
  if (entry?.status === 'ready') return entry.path;
  if (!entry) {
    files.set(key, { status: 'pending' });
    window.api.reversePreview(req).then(
      (path) => {
        files.set(key, { status: 'ready', path });
        store.emit('reverse-ready');
      },
      () => files.set(key, { status: 'error' }),
    );
  }
  return null;
}
