// Preview playback for unlinked audio-track clips (music, voice-over, unlinked
// clip sound). Each clip under (or just ahead of) the
// playhead gets its own <audio> element that follows the playhead: started at
// the right source position, volume shaped by fades, resynced if it drifts.
// The video element (or the wall clock in gaps) stays the master clock.

import { store } from './store.js';
import { mediaUrl } from './util.js';
import * as tl from '../../shared/timeline.js';

const PRELOAD_AHEAD = 2; // seconds: get upcoming clips loaded and seeked
// Drift handling: small drift (startup latency, clock differences) is pulled in
// smoothly by nudging playbackRate (pitch preserved); only big jumps re-seek,
// because a seek itself costs tens of milliseconds while the playhead moves on.
const MAX_DRIFT = 0.25; // seconds: beyond this, seek
const DEAD_ZONE = 0.012; // seconds: close enough, play at normal speed
const RATE_GAIN = 2; // rate change per second of drift
const MAX_RATE_CHANGE = 0.1;

export class AudioTracksPlayer {
  constructor(failedSrcs) {
    this.entries = new Map(); // clipId -> { el, src }
    this.failedSrcs = failedSrcs; // shared with the video preview
  }

  sourceFor(media) {
    if (media.proxyPath) return media.proxyPath;
    if (!this.failedSrcs.has(media.path)) return media.path;
    return null;
  }

  entryFor(clipId, src) {
    let entry = this.entries.get(clipId);
    if (!entry) {
      const el = new Audio();
      el.preload = 'auto';
      entry = { el, src: null };
      el.addEventListener('error', () => {
        if (entry.src) this.failedSrcs.add(entry.src);
        entry.src = null;
      });
      this.entries.set(clipId, entry);
    }
    if (entry.src !== src) {
      entry.src = src;
      entry.el.src = mediaUrl(src);
    }
    return entry;
  }

  /** Bring all audio elements in line with time t. */
  sync(t, playing) {
    const project = store.project;
    const keep = new Set();

    for (const track of tl.audioTracks(project)) {
      for (const clip of track.clips) {
        // Linked clip sound is played by the video element itself (see preview.js).
        if (tl.isLinkedToVideo(project, clip)) continue;
        const end = tl.clipEnd(clip);
        const current = t >= clip.start && t < end;
        const upcoming = clip.start > t && clip.start - t <= PRELOAD_AHEAD;
        if (!(current || upcoming) || (!playing && !upcoming && !current)) continue;
        const media = tl.findMedia(project, clip.mediaId);
        const src = media && this.sourceFor(media);
        if (!src) continue;
        keep.add(clip.id);
        const { el } = this.entryFor(clip.id, src);

        if (!current || !playing || track.muted || clip.muted) {
          // Park it at its start point, ready to go.
          if (!el.paused) el.pause();
          const parkAt = current ? clip.in + (t - clip.start) : clip.in;
          if (!el.seeking && Math.abs(el.currentTime - parkAt) > MAX_DRIFT) el.currentTime = parkAt;
          continue;
        }
        const rel = t - clip.start;
        const target = clip.in + rel;
        el.volume = Math.min(1, clip.volume * tl.fadeGain(clip, rel));
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
          el.playbackRate = 1;
          el.play().catch(() => {});
        } else if (!el.seeking) {
          const drift = el.currentTime - target; // negative = behind
          if (Math.abs(drift) > MAX_DRIFT) {
            el.currentTime = target;
            el.playbackRate = 1;
          } else if (Math.abs(drift) < DEAD_ZONE) {
            el.playbackRate = 1;
          } else {
            const change = Math.max(-MAX_RATE_CHANGE, Math.min(MAX_RATE_CHANGE, -drift * RATE_GAIN));
            el.playbackRate = 1 + change;
          }
        }
      }
    }

    for (const [id, entry] of this.entries) {
      if (keep.has(id)) continue;
      entry.el.pause();
      entry.el.removeAttribute('src');
      entry.el.load();
      this.entries.delete(id);
    }
  }

  stopAll() {
    for (const { el } of this.entries.values()) el.pause();
  }
}
