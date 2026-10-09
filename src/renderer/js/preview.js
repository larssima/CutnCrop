// Timeline playback in a single <video> element. While a clip plays, the video's
// own clock drives the playhead (smooth audio); in gaps the wall clock does.
// While the video is loading or seeking the playhead holds, so it never jumps back.
//
// Source mode (store.source set): the same element shows one media file on its
// own, with its own time and a scrub bar, so files can be checked before they
// go on the timeline.

import { store } from './store.js';
import { mediaUrl, h, $ } from './util.js';
import { AudioTracksPlayer } from './audioPlayer.js';
import { reversedFileFor } from './reversePreview.js';
import {
  clipAt, clipEnd, findMedia, projectDuration, sortedClips, textTrack, fadeGain, trackOfClip, linkedAudioOf,
  videoTrack, audioTracks, isLinkedToVideo,
} from '../../shared/timeline.js';
import { isReversed, sourceTimeAt } from '../../shared/effects.js';
import { frameDuration } from '../../shared/time.js';

export class Preview {
  constructor(root) {
    this.frame = $('.preview-frame', root);
    this.video = $('video', root);
    this.overlay = $('.text-overlay', root);
    this.message = $('.preview-message', root);
    this.note = $('.preview-note', root);
    this.clipMode = 'forward'; // 'forward' | 'reverse-file' | 'reverse-step' for the clip under the playhead
    this.sourceBadge = $('.source-badge', root);
    this.sourceBar = $('.source-bar', root);
    this.sourceFill = $('.source-fill', root);
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
      this.prefetchReversed();
      this.sync();
    });
    store.on('reverse-ready', () => this.sync());
    store.on('playhead', () => {
      if (!this.playing) this.sync();
    });
    store.on('media-status', () => this.sync());
    store.on('source', () => this.onSourceChange());
    store.on('source-time', () => {
      this.renderSourceBar();
      if (!this.playing) this.sync();
    });
    $('.source-close', root).addEventListener('click', () => store.closeSource());

    // Scrub bar: click or drag to move through the source file.
    const scrubTo = (e) => {
      const media = this.sourceMedia();
      if (!media) return;
      const box = this.sourceBar.getBoundingClientRect();
      store.setSourceTime(((e.clientX - box.left) / box.width) * media.duration);
    };
    this.sourceBar.addEventListener('pointerdown', (e) => {
      if (this.playing) this.pause();
      this.sourceBar.setPointerCapture(e.pointerId);
      scrubTo(e);
    });
    this.sourceBar.addEventListener('pointermove', (e) => {
      if (this.sourceBar.hasPointerCapture(e.pointerId)) scrubTo(e);
    });

    new ResizeObserver(() => this.fitFrame()).observe(this.frame.parentElement);
    this.fitFrame();
  }

  sourceMedia() {
    return store.source ? findMedia(store.project, store.source.mediaId) : null;
  }

  onSourceChange() {
    if (this.playing) this.pause();
    const media = this.sourceMedia();
    this.sourceBadge.hidden = !media;
    this.sourceBar.hidden = !media;
    if (media) this.sourceBadge.querySelector('.source-name').textContent = media.name;
    this.fitFrame();
    this.renderSourceBar();
    this.sync();
  }

  renderSourceBar() {
    const media = this.sourceMedia();
    if (media) this.sourceFill.style.width = `${(store.source.time / media.duration) * 100}%`;
  }

  /** Size the frame to the project (or source file) aspect ratio inside the available area. */
  fitFrame() {
    const media = this.sourceMedia();
    const { width, height } = media?.hasVideo ? media : store.project.settings;
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
    const media = this.sourceMedia();
    if (media) {
      if (store.source.time >= media.duration - 0.05) store.setSourceTime(0);
    } else {
      const duration = projectDuration(store.project);
      if (duration <= 0) return;
      if (store.playhead >= duration - frameDuration(store.project.settings.fps)) store.setPlayhead(0);
    }
    this.playing = true;
    this.lastTick = performance.now();
    store.emit('playstate', true);
    this.sync();
    requestAnimationFrame(() => this.tick());
  }

  pause() {
    this.playing = false;
    this.video.pause();
    // Stay on the frame where playback stopped instead of seeking back to the
    // slightly older time of the last animation frame.
    if (store.source && this.currentSrc && this.video.readyState >= 2) store.setSourceTime(this.video.currentTime);
    this.audio.stopAll();
    store.emit('playstate', false);
    this.sync();
  }

  tick() {
    if (!this.playing) return;
    const now = performance.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    const media = this.sourceMedia();
    if (media) {
      // Source mode: the file's own clock is the time.
      if (this.videoReady()) store.setSourceTime(this.video.currentTime);
      if (this.video.ended || store.source.time >= media.duration - 0.01) {
        store.setSourceTime(media.duration);
        this.pause();
        return;
      }
      requestAnimationFrame(() => this.tick());
      return;
    }

    const project = store.project;
    const clip = clipAt(project, store.playhead);
    let t = store.playhead;
    if (!clip) {
      t += dt;
      // Don't skip over the start of the next clip.
      const next = sortedClips(project).find((c) => c.start > store.playhead);
      if (next && t > next.start) t = next.start;
    } else if (this.clipMode === 'reverse-step') {
      t += dt; // reversed preview not ready: frames are stepped to the wall clock
    } else if (this.videoReady()) {
      // A reversed preview file starts at the clip start; a source file at `in`.
      t = clip.start + (this.clipMode === 'reverse-file' ? this.video.currentTime : this.video.currentTime - clip.in);
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

  /** Make the video element show the right frame for the playhead (or source time). */
  sync() {
    if (store.source) return this.syncSource();
    const project = store.project;
    const t = store.playhead;
    const clip = clipAt(project, t);
    this.renderText();
    this.audio.sync(t, this.playing);

    if (!clip) {
      this.video.style.visibility = 'hidden';
      this.showMessage(null);
      this.showNote(null);
      this.clipMode = 'forward';
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

    // A linked audio clip has the same timing and file as the video, so the
    // video element plays it directly (exact lip sync); unlinked audio plays
    // through the audio-track player instead.
    const linked = linkedAudioOf(project, clip);
    const linkedTrack = linked && trackOfClip(project, linked.id);

    // Which file and position: forward clips play their source. Reversed clips
    // play a pre-rendered reversed file; until it exists (and always while
    // paused, which is instant and exact) the right frame is shown by seeking
    // the source backwards.
    const rel = t - clip.start;
    let file = src;
    let target = clip.in + rel;
    this.clipMode = 'forward';
    if (isReversed(clip)) {
      const reversedFile = reversedFileFor(clip, { video: true, audio: Boolean(linked && isReversed(linked)) });
      if (this.playing && reversedFile) {
        file = reversedFile;
        target = rel;
        this.clipMode = 'reverse-file';
      } else {
        target = Math.max(clip.in, sourceTimeAt(clip, rel) - 0.5 * frameDuration(project.settings.fps));
        this.clipMode = 'reverse-step';
      }
    }
    this.showNote(this.playing && this.clipMode === 'reverse-step' ? 'Preparing reversed preview… (silent until ready)' : null);

    if (this.currentSrc !== file) {
      this.currentSrc = file;
      this.video.src = mediaUrl(file);
      this.video.currentTime = target;
    }

    this.video.volume = linked ? Math.min(1, linked.volume * fadeGain(linked, rel)) : 0;
    if (this.playing && this.clipMode !== 'reverse-step') {
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

  /** Source mode: show the selected media file at store.source.time. */
  syncSource() {
    const media = this.sourceMedia();
    if (!media) return store.closeSource();
    this.overlay.replaceChildren(); // timeline text doesn't belong on a source file
    this.showNote(null);
    this.clipMode = 'forward';
    this.lastTextKey = null;
    this.audio.stopAll();

    const src = this.sourceFor(media);
    if (!src) {
      this.video.style.visibility = 'hidden';
      const pct = Math.round((store.mediaStatus.get(media.id)?.proxyProgress ?? 0) * 100);
      this.showMessage(`Preparing preview… ${pct}%`);
      return;
    }
    // Audio files play through the same element; show a placeholder instead of a picture.
    this.video.style.visibility = media.hasVideo ? 'visible' : 'hidden';
    this.showMessage(media.hasVideo ? null : `♪ ${media.name}`);

    const target = store.source.time;
    if (this.currentSrc !== src) {
      this.currentSrc = src;
      this.video.src = mediaUrl(src);
      this.video.currentTime = target;
    }
    this.video.volume = 1;
    if (this.playing) {
      this.video.muted = false;
      if (this.video.paused) {
        this.seek(target);
        this.video.play().catch(() => {});
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
    // Issue the queued seek on the next frame, not inside the 'seeked' handler:
    // Chromium updates currentTime for a seek started there but never paints its frame.
    requestAnimationFrame(() => {
      if (this.pendingSeek === null) return;
      const t = this.pendingSeek;
      this.pendingSeek = null;
      this.seek(t);
    });
  }

  showMessage(text) {
    this.message.textContent = text ?? '';
    this.message.hidden = !text;
  }

  /** Small corner note that doesn't hide the picture. */
  showNote(text) {
    this.note.textContent = text ?? '';
    this.note.hidden = !text;
  }

  /** Start rendering reversed previews for every reversed clip, so they're ready by play time. */
  prefetchReversed() {
    const project = store.project;
    for (const clip of videoTrack(project).clips) {
      if (!isReversed(clip)) continue;
      const linked = linkedAudioOf(project, clip);
      reversedFileFor(clip, { video: true, audio: Boolean(linked && isReversed(linked)) });
    }
    for (const track of audioTracks(project)) {
      for (const clip of track.clips) {
        if (isReversed(clip) && !isLinkedToVideo(project, clip)) reversedFileFor(clip, { video: false, audio: true });
      }
    }
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
