// Timeline playback in a single <video> element. While a clip plays, the video's
// own clock drives the playhead (smooth audio); in gaps the wall clock does.
// While the video is loading or seeking the playhead holds, so it never jumps back.

import { store } from './store.js';
import { mediaUrl, h, $ } from './util.js';
import { AudioTracksPlayer } from './audioPlayer.js';
import {
  clipAt, clipEnd, findMedia, projectDuration, sortedClips, textTrack, fadeGain, trackOfClip, linkedAudioOf,
} from '../../shared/timeline.js';
import { frameDuration } from '../../shared/time.js';

export class Preview {
  constructor(root) {
    this.frame = $('.preview-frame', root);
    this.video = $('video', root);
    this.overlay = $('.text-overlay', root);
    this.message = $('.preview-message', root);
    this.playing = false;
    this.lastTick = 0;
    this.currentSrc = null;
    this.failedSrcs = new Set(); // originals Chromium can't decode (e.g. WMV)
    this.pendingSeek = null;
    this.audio = new AudioTracksPlayer(this.failedSrcs);

    this.video.addEventListener('seeked', () => this.flushSeek());
    this.video.addEventListener('error', () => {
      if (this.currentSrc) this.failedSrcs.add(this.currentSrc);
      this.currentSrc = null;
      this.sync();
    });

    store.on('project', () => {
      this.fitFrame();
      this.sync();
    });
    store.on('playhead', () => {
      if (!this.playing) this.sync();
    });
    store.on('media-status', () => this.sync());
    new ResizeObserver(() => this.fitFrame()).observe(this.frame.parentElement);
    this.fitFrame();
  }

  /** Size the frame to the project aspect ratio inside the available area. */
  fitFrame() {
    const { width, height } = store.project.settings;
    const box = this.frame.parentElement.getBoundingClientRect();
    const scale = Math.min(box.width / width, box.height / height);
    this.frame.style.width = `${Math.floor(width * scale)}px`;
    this.frame.style.height = `${Math.floor(height * scale)}px`;
    this.scale = scale;
    this.renderText(true);
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
  }

  play() {
    const duration = projectDuration(store.project);
    if (duration <= 0) return;
    if (store.playhead >= duration - frameDuration(store.project.settings.fps)) store.setPlayhead(0);
    this.playing = true;
    this.lastTick = performance.now();
    store.emit('playstate', true);
    this.sync();
    requestAnimationFrame(() => this.tick());
  }

  pause() {
    this.playing = false;
    this.video.pause();
    this.audio.stopAll();
    store.emit('playstate', false);
    this.sync();
  }

  tick() {
    if (!this.playing) return;
    const now = performance.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    const project = store.project;
    const clip = clipAt(project, store.playhead);
    let t = store.playhead;
    if (!clip) {
      t += dt;
      // Don't skip over the start of the next clip.
      const next = sortedClips(project).find((c) => c.start > store.playhead);
      if (next && t > next.start) t = next.start;
    } else if (this.videoReady()) {
      t = clip.start + (this.video.currentTime - clip.in);
      if (this.video.ended || t >= clipEnd(clip)) t = clipEnd(clip);
    } else if (!this.hasSource(clip)) {
      t += dt; // no preview available yet: keep time moving
    }

    const duration = projectDuration(project);
    if (t >= duration) {
      store.setPlayhead(duration);
      this.pause();
      return;
    }
    store.setPlayhead(Math.max(t, store.playhead));
    this.sync();
    requestAnimationFrame(() => this.tick());
  }

  videoReady() {
    return this.currentSrc && !this.video.seeking && this.video.readyState >= 3 && !this.video.paused;
  }

  /** Best available source for a media item: proxy, else the original if playable. */
  sourceFor(media) {
    if (media.proxyPath) return media.proxyPath;
    if (!this.failedSrcs.has(media.path)) return media.path;
    return null;
  }

  hasSource(clip) {
    const media = findMedia(store.project, clip.mediaId);
    return Boolean(media && this.sourceFor(media));
  }

  /** Make the video element show the right frame for the playhead. */
  sync() {
    const project = store.project;
    const t = store.playhead;
    const clip = clipAt(project, t);
    this.renderText();
    this.audio.sync(t, this.playing);

    if (!clip) {
      this.video.style.visibility = 'hidden';
      this.showMessage(null);
      if (!this.video.paused) this.video.pause();
      return;
    }
    const media = findMedia(project, clip.mediaId);
    const src = this.sourceFor(media);
    if (!src) {
      this.video.style.visibility = 'hidden';
      const pct = Math.round((store.mediaStatus.get(media.id)?.proxyProgress ?? 0) * 100);
      this.showMessage(`Preparing preview… ${pct}%`);
      return;
    }
    this.showMessage(null);
    this.video.style.visibility = 'visible';

    const target = clip.in + (t - clip.start);
    if (this.currentSrc !== src) {
      this.currentSrc = src;
      this.video.src = mediaUrl(src);
      this.video.currentTime = target;
    }

    // A linked audio clip has the same timing and file as the video, so the
    // video element plays it directly (exact lip sync); unlinked audio plays
    // through the audio-track player instead.
    const linked = linkedAudioOf(project, clip);
    const linkedTrack = linked && trackOfClip(project, linked.id);
    this.video.volume = linked ? Math.min(1, linked.volume * fadeGain(linked, t - linked.start)) : 0;
    if (this.playing) {
      this.video.muted = !linked || linked.muted || linkedTrack.muted;
      if (this.video.paused) {
        this.seek(target);
        this.video.play().catch(() => {});
      } else if (!this.video.seeking && Math.abs(this.video.currentTime - target) > 0.25) {
        // Jumped to another clip of the same file, or drifted: resync.
        this.seek(target);
      }
    } else {
      if (!this.video.paused) this.video.pause();
      this.seek(target);
    }
  }

  /** Coalesce seeks while one is in flight so scrubbing stays responsive. */
  seek(time) {
    if (this.video.seeking) {
      this.pendingSeek = time;
      return;
    }
    if (Math.abs(this.video.currentTime - time) > 0.001) this.video.currentTime = time;
  }

  flushSeek() {
    if (this.pendingSeek === null) return;
    const t = this.pendingSeek;
    this.pendingSeek = null;
    this.seek(t);
  }

  showMessage(text) {
    this.message.textContent = text ?? '';
    this.message.hidden = !text;
  }

  /** Text overlays mirror the export's drawtext placement: centered at (x, y). */
  renderText(force = false) {
    const t = store.playhead;
    const items = textTrack(store.project).items.filter((x) => t >= x.start && t < x.end);
    const key = JSON.stringify(items) + this.scale;
    if (!force && key === this.lastTextKey) return;
    this.lastTextKey = key;
    const selected = store.selection?.kind === 'text' ? store.selection.id : null;
    this.overlay.replaceChildren(
      ...items.map((x) =>
        h('div.overlay-text' + (x.id === selected ? '.selected' : ''), {
          style: {
            left: `${x.x * 100}%`,
            top: `${x.y * 100}%`,
            fontSize: `${x.size * this.scale}px`,
            color: x.color,
            WebkitTextStroke: `${Math.max(1, (x.size / 16) * this.scale) * 2}px rgba(0,0,0,0.8)`,
          },
        }, x.text),
      ),
    );
  }
}
