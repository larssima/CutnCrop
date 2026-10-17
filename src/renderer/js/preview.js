// Timeline playback. While a clip plays, the video's own clock drives the
// playhead (smooth audio); in gaps and on images the wall clock does. While a
// video is loading or seeking the playhead holds, so it never jumps back.
//
// Two <video> elements take turns (double buffering): one is shown, the other
// ("standby") preloads the next clip's file at its first frame, so a cut to a
// different file is an instant swap instead of a load with a black flash.
//
// Source mode (store.source set): the shown element plays one media file on its
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
import { cropOf, cropLayout } from '../../shared/transform.js';
import { CropEditor } from './cropEditor.js';

const NO_CROP = { left: 0, right: 0, top: 0, bottom: 0 };
import { frameDuration } from '../../shared/time.js';

const PRELOAD_AHEAD = 3; // seconds before a cut to start loading the next clip

export class Preview {
  constructor(root) {
    this.frame = $('.preview-frame', root);
    this.videos = [...root.querySelectorAll('.preview-frame video')];
    this.activeIndex = 0;
    this.overlay = $('.text-overlay', root);
    this.message = $('.preview-message', root);
    this.note = $('.preview-note', root);
    this.image = $('.preview-image', root);
    this.clipMode = 'forward'; // 'forward' | 'reverse-file' | 'reverse-step' | 'image' for the clip under the playhead
    this.sourceBadge = $('.source-badge', root);
    this.sourceBar = $('.source-bar', root);
    this.sourceFill = $('.source-fill', root);
    this.playing = false;
    this.lastTick = 0;
    this.failedSrcs = new Set(); // originals Chromium can't decode (e.g. WMV)
    this.pendingSeek = null;
    this.audio = new AudioTracksPlayer(this.failedSrcs);
    this.cropEditor = new CropEditor(this.frame);
    store.on('crop-edit', () => {
      if (store.cropEdit && this.playing) this.pause();
      this.sync();
    });

    for (const el of this.videos) {
      el.muted = true;
      el.addEventListener('seeked', () => el === this.video && this.flushSeek());
      el.addEventListener('error', () => {
        if (el.dataset.file) this.failedSrcs.add(el.dataset.file);
        el.dataset.file = '';
        if (el === this.video) this.sync();
      });
    }

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

  /** The video element being shown. */
  get video() {
    return this.videos[this.activeIndex];
  }

  /** The other video element, preloading what comes next. */
  get standby() {
    return this.videos[1 - this.activeIndex];
  }

  /** File loaded in the shown element (null if none). */
  get currentSrc() {
    return this.video.dataset.file || null;
  }

  sourceMedia() {
    return store.source ? findMedia(store.project, store.source.mediaId) : null;
  }

  onSourceChange() {
    if (this.playing) this.pause();
    const media = this.sourceMedia();
    this.sourceBadge.hidden = !media;
    this.sourceBar.hidden = !media || media.isImage;
    if (media) this.sourceBadge.querySelector('.source-name').textContent = media.name;
    this.fitFrame();
    this.renderSourceBar();
    this.sync();
  }

  renderSourceBar() {
    const media = this.sourceMedia();
    if (media && !media.isImage) this.sourceFill.style.width = `${(store.source.time / media.duration) * 100}%`;
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
    // Re-place pictures for the new frame size.
    for (const el of [...this.videos, this.image]) if (el.layoutArgs) this.layout(el, ...el.layoutArgs);
  }

  /**
   * Size and position a video/image element so that the cropped area of the
   * media fits the frame (like object-fit: contain), and clip off the rest.
   * Mirrors the export: crop first, then scale to fit.
   */
  layout(el, media, crop) {
    el.layoutArgs = [media, crop];
    const boxW = parseFloat(this.frame.style.width) || this.frame.clientWidth;
    const boxH = parseFloat(this.frame.style.height) || this.frame.clientHeight;
    if (!media?.width || !media?.height || !boxW) {
      Object.assign(el.style, { left: '0px', top: '0px', width: '100%', height: '100%', clipPath: '', objectFit: 'contain' });
      return;
    }
    const l = cropLayout(media.width, media.height, crop ?? NO_CROP, boxW, boxH);
    Object.assign(el.style, {
      left: `${l.left}px`, top: `${l.top}px`, width: `${l.width}px`, height: `${l.height}px`,
      clipPath: `inset(${l.inset})`, objectFit: 'fill',
    });
  }

  /**
   * The crop to show for a clip: none in crop mode (the full picture is shown,
   * with the crop rectangle on top), otherwise the clip's crop.
   */
  shownCrop(clip) {
    return store.cropEdit === clip.id ? NO_CROP : cropOf(clip);
  }

  /** Crop mode: show the editor over this clip's full picture, or hide it. */
  renderCropEditor(clip, media) {
    if (!store.cropEdit) return this.cropEditor.hide();
    if (clip?.id !== store.cropEdit) {
      // The playhead left the clip being cropped: crop mode ends.
      this.cropEditor.hide();
      queueMicrotask(() => store.setCropEdit(null));
      return;
    }
    const boxW = parseFloat(this.frame.style.width);
    const boxH = parseFloat(this.frame.style.height);
    const l = cropLayout(media.width, media.height, NO_CROP, boxW, boxH);
    this.cropEditor.show(clip, { left: l.left, top: l.top, width: l.width, height: l.height });
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
  }

  play() {
    const media = this.sourceMedia();
    if (media?.isImage) return; // a still has nothing to play
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
    for (const el of this.videos) el.pause();
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
    } else if (this.clipMode === 'reverse-step' || this.clipMode === 'image') {
      t += dt; // stills and not-yet-ready reversed previews follow the wall clock
    } else if (this.reachedClipEnd(clip)) {
      // The file ran out where the clip ends (the browser pauses a video by itself
      // at its end): the clip is done, go on to the next one.
      t = clipEnd(clip);
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

  /**
   * Has the shown video played up to the end of this clip? True when the file
   * ended, or when it is within half a frame of the clip's end in file time
   * (a reversed preview file starts at the clip start; a source file at `in`).
   */
  reachedClipEnd(clip) {
    if (!this.currentSrc || this.video.seeking) return false;
    if (this.video.ended) return true;
    return this.video.currentTime >= this.fileEndOf(clip) - 0.5 * frameDuration(store.project.settings.fps);
  }

  /** File time at which a clip ends in the file the shown element plays for it. */
  fileEndOf(clip) {
    return this.clipMode === 'reverse-file' ? clip.out - clip.in : clip.out;
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

  /**
   * What to show for a video clip at timeline time t:
   *   { mode: 'image' } | { mode: 'missing', media } |
   *   { mode: 'forward' | 'reverse-file' | 'reverse-step', file, target, linked }
   * Forward clips play their source. Reversed clips play a pre-rendered reversed
   * file; until it exists (and always while paused, which is instant and exact)
   * the right frame is shown by seeking the source backwards.
   */
  plan(clip, t, playing) {
    const project = store.project;
    const media = findMedia(project, clip.mediaId);
    if (media.isImage) return { mode: 'image', media };
    const src = this.sourceFor(media);
    if (!src) return { mode: 'missing', media };
    // A linked audio clip has the same timing and file as the video, so the
    // video element plays it directly (exact lip sync); unlinked audio plays
    // through the audio-track player instead.
    const linked = linkedAudioOf(project, clip);
    const rel = t - clip.start;
    if (!isReversed(clip)) return { mode: 'forward', file: src, target: clip.in + rel, linked, media };
    const reversedFile = reversedFileFor(clip, { video: true, audio: Boolean(linked && isReversed(linked)) });
    if (playing && reversedFile) return { mode: 'reverse-file', file: reversedFile, target: rel, linked, media };
    const target = Math.max(clip.in, sourceTimeAt(clip, rel) - 0.5 * frameDuration(project.settings.fps));
    return { mode: 'reverse-step', file: src, target, linked, media };
  }

  /** Point an element at a file and position. */
  load(el, file, time) {
    el.dataset.file = file;
    el.src = mediaUrl(file);
    el.currentTime = time;
  }

  /** Show the standby element instead of the current one (it was preloaded). */
  swap() {
    const old = this.video;
    old.pause();
    old.muted = true;
    this.activeIndex = 1 - this.activeIndex;
    this.pendingSeek = null;
    old.classList.remove('shown');
  }

  setVideoShown(shown) {
    this.video.classList.toggle('shown', shown);
    this.standby.classList.remove('shown');
  }

  /**
   * Get the standby element ready for the next video clip after time `after`,
   * when it starts within PRELOAD_AHEAD seconds. Skipped when the shown element
   * just continues into it (same file, contiguous) or it isn't a playable video.
   */
  preloadNext(after, continuing = null) {
    const next = sortedClips(store.project).find((c) => c.start >= after - 1e-6);
    if (!next || next.start - store.playhead > PRELOAD_AHEAD) return;
    const p = this.plan(next, next.start, true);
    if (p.mode !== 'forward' && p.mode !== 'reverse-file') return;
    if (continuing && continuing.file === p.file && Math.abs(continuing.time - p.target) < 0.05) return;
    const sb = this.standby;
    sb.muted = true;
    if (!sb.paused) sb.pause();
    if (sb.dataset.file !== p.file) this.load(sb, p.file, p.target);
    else if (!sb.seeking && Math.abs(sb.currentTime - p.target) > 0.02) sb.currentTime = p.target;
    this.layout(sb, p.media, cropOf(next)); // ready-cropped, so the swap is seamless
  }

  /** Make the shown video element show the right frame for the playhead (or source time). */
  sync() {
    if (store.source) return this.syncSource();
    const project = store.project;
    const t = store.playhead;
    const clip = clipAt(project, t);
    this.renderText();
    this.audio.sync(t, this.playing);

    if (!clip) {
      this.setVideoShown(false);
      this.showImage(null);
      this.showMessage(null);
      this.showNote(null);
      this.clipMode = 'forward';
      this.renderCropEditor(null);
      if (!this.video.paused) this.video.pause();
      if (this.playing) this.preloadNext(t);
      return;
    }
    const p = this.plan(clip, t, this.playing);
    if (p.mode === 'image') {
      this.clipMode = 'image';
      this.showNote(null);
      this.setVideoShown(false);
      if (!this.video.paused) this.video.pause();
      this.showImage(p.media);
      this.layout(this.image, p.media, this.shownCrop(clip));
      this.renderCropEditor(clip, p.media);
      if (this.playing) this.preloadNext(clipEnd(clip));
      return;
    }
    this.showImage(null);
    if (p.mode === 'missing') {
      this.cropEditor.hide();
      this.setVideoShown(false);
      const pct = Math.round((store.mediaStatus.get(p.media.id)?.proxyProgress ?? 0) * 100);
      this.showMessage(`Preparing preview… ${pct}%`);
      return;
    }
    this.showMessage(null);
    this.clipMode = p.mode;
    this.showNote(this.playing && p.mode === 'reverse-step' ? 'Preparing reversed preview… (silent until ready)' : null);

    if (this.currentSrc !== p.file) {
      // Use the preloaded standby if it's ready at this frame; otherwise load here.
      const sb = this.standby;
      const ready = sb.dataset.file === p.file && sb.readyState >= 2 && !sb.seeking && Math.abs(sb.currentTime - p.target) < 0.15;
      if (ready) this.swap();
      else this.load(this.video, p.file, p.target);
    }
    this.layout(this.video, p.media, this.shownCrop(clip));
    this.setVideoShown(true);
    this.renderCropEditor(clip, p.media);

    const { linked } = p;
    const linkedTrack = linked && trackOfClip(project, linked.id);
    this.video.volume = linked ? Math.min(1, linked.volume * fadeGain(linked, t - clip.start)) : 0;
    if (this.playing && p.mode !== 'reverse-step') {
      this.video.muted = !linked || linked.muted || linkedTrack.muted;
      if (this.video.paused) {
        this.seek(p.target);
        this.video.play().catch(() => {});
      } else if (!this.video.seeking && Math.abs(this.video.currentTime - p.target) > 0.25) {
        // Jumped to another clip of the same file, or drifted: resync.
        this.seek(p.target);
      }
      this.preloadNext(clipEnd(clip), { file: p.file, time: this.fileEndOf(clip) });
    } else {
      if (!this.video.paused) this.video.pause();
      this.seek(p.target);
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
    this.standby.pause();
    this.cropEditor.hide();
    if (media.isImage) {
      this.audio.stopAll();
      this.setVideoShown(false);
      if (!this.video.paused) this.video.pause();
      this.showImage(media);
      this.layout(this.image, media, NO_CROP); // the source file as it is
      return;
    }
    this.showImage(null);
    this.audio.stopAll();

    const src = this.sourceFor(media);
    if (!src) {
      this.setVideoShown(false);
      const pct = Math.round((store.mediaStatus.get(media.id)?.proxyProgress ?? 0) * 100);
      this.showMessage(`Preparing preview… ${pct}%`);
      return;
    }
    // Audio files play through the same element; show a placeholder instead of a picture.
    this.setVideoShown(media.hasVideo);
    this.showMessage(media.hasVideo ? null : `♪ ${media.name}`);

    const target = store.source.time;
    if (this.currentSrc !== src) this.load(this.video, src, target);
    this.layout(this.video, media, NO_CROP);
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

  /**
   * Show a still image (its preview copy, which matches the export: orientation,
   * transparency as black), or hide the image layer with null.
   */
  showImage(media) {
    if (!media) {
      this.image.hidden = true;
      return;
    }
    if (!media.proxyPath) {
      this.image.hidden = true;
      this.showMessage('Preparing image…');
      return;
    }
    this.showMessage(null);
    const url = mediaUrl(media.proxyPath);
    if (this.image.dataset.src !== url) {
      this.image.dataset.src = url;
      this.image.src = url;
    }
    this.image.hidden = false;
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
