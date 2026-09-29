// Timeline: ruler, text lane, video lane and audio lanes. Pointer gestures:
// click/drag the ruler or empty space to scrub, drag clips to move (audio clips
// can change audio lane), drag edges to trim, drag the round handles on audio
// clips to set fades. Moves and trims snap to the playhead and to clip edges.

import { store } from './store.js';
import { h, $, mediaUrl } from './util.js';
import { getPeaks, PEAKS_PER_SECOND } from './media.js';
import * as tl from '../../shared/timeline.js';
import { formatDuration } from '../../shared/time.js';

const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const MAX_CANVAS_PX = 4096;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
export const MEDIA_DRAG_TYPE = 'application/x-cutncrop-media';

/**
 * Does a clip selection include the clip's linked partners? A video clip is
 * selected with its sound unless Ctrl+clicked (withLinked: false); a sound clip
 * is selected alone. Matches deleteClip's defaults.
 */
export function selectsLinked(project, sel) {
  if (sel?.kind !== 'clip') return false;
  if (sel.withLinked !== undefined) return sel.withLinked;
  return tl.trackOfClip(project, sel.id)?.type === 'video';
}

/** Lane order on screen: text on top, then video, then audio tracks. */
function laneOrder(project) {
  return [tl.textTrack(project), tl.videoTrack(project), ...tl.audioTracks(project)];
}

/**
 * Draw an audio clip's waveform (optionally shaped by its fades) onto a canvas
 * covering the clip. Peaks are linear 0..255; sqrt scaling makes quiet parts visible.
 */
function drawWaveform(canvas, peaks, clip, zoom, { color, fades }) {
  const cssWidth = tl.clipDuration(clip) * zoom;
  const width = Math.max(1, Math.min(MAX_CANVAS_PX, Math.round(cssWidth)));
  const height = canvas.clientHeight || 40;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const secondsPerPx = tl.clipDuration(clip) / width;
  const mid = height / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < width; x++) {
    const rel = x * secondsPerPx;
    const from = Math.floor((clip.in + rel) * PEAKS_PER_SECOND);
    const to = Math.max(from + 1, Math.floor((clip.in + rel + secondsPerPx) * PEAKS_PER_SECOND));
    let peak = 0;
    for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
    let amp = Math.sqrt(peak / 255) * Math.min(1, clip.volume);
    if (fades) amp *= tl.fadeGain(clip, rel);
    const hgt = Math.max(1, amp * (height - 2));
    ctx.fillRect(x, mid - hgt / 2, 1, hgt);
  }
  if (fades && (clip.fadeIn > 0 || clip.fadeOut > 0)) {
    // Fade envelope line.
    const dur = tl.clipDuration(clip);
    ctx.strokeStyle = 'rgba(255, 220, 120, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, clip.fadeIn > 0 ? height : 1);
    ctx.lineTo((clip.fadeIn / dur) * width, 1);
    ctx.lineTo(((dur - clip.fadeOut) / dur) * width, 1);
    ctx.lineTo(width, clip.fadeOut > 0 ? height : 1);
    ctx.stroke();
  }
}

export class TimelineView {
  constructor(root) {
    this.scroll = $('.timeline-scroll', root);
    this.content = $('.timeline-content', root);
    this.ruler = $('.ruler', root);
    this.lanes = $('.lanes', root);
    this.headers = $('.track-rows', root);
    this.playheadEl = $('.playhead', root);
    this.gesture = null;

    store.on('project', () => this.render());
    store.on('selection', () => this.render());
    store.on('zoom', () => this.render());
    store.on('peaks', () => this.render());
    store.on('playhead', () => this.renderPlayhead());
    store.on('playstate', (playing) => (this.playing = playing));

    this.content.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.content.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.content.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.content.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    this.lanes.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes(MEDIA_DRAG_TYPE) && e.target.closest('.lane.video, .lane.audio')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.lanes.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
      const lane = e.target.closest('.lane.video, .lane.audio');
      if (!id || !lane) return;
      e.preventDefault();
      e.stopPropagation();
      this.dropMedia(id, lane.dataset.trackId, this.snap(this.timeAt(e.clientX)));
    });

    new ResizeObserver(() => this.render()).observe(this.scroll);
  }

  /** Media dropped on a lane: audio lanes take the media's audio; the video lane takes video. */
  dropMedia(mediaId, trackId, t) {
    const media = tl.findMedia(store.project, mediaId);
    const track = tl.findTrack(store.project, trackId);
    let target = null;
    if (track.type === 'audio') {
      if (!media.hasAudio) return;
      target = trackId;
    } else if (!media.hasVideo) {
      target = null; // audio file dropped on video lane -> first audio track
    }
    const clip = store.edit((p) => tl.addClip(p, mediaId, t, target));
    store.select({ kind: 'clip', id: clip.id });
  }

  /** Lane the pointer is over (for OS file drops). */
  trackAt(target) {
    return target.closest?.('.lane.video, .lane.audio')?.dataset.trackId ?? null;
  }

  timeAt(clientX) {
    return Math.max(0, (clientX - this.content.getBoundingClientRect().left) / store.zoom);
  }

  x(t) {
    return t * store.zoom;
  }

  zoomToFit() {
    const duration = tl.projectDuration(store.project);
    if (duration > 0) store.setZoom((this.scroll.clientWidth - 60) / duration);
  }

  render() {
    const project = store.project;
    const z = store.zoom;
    const duration = tl.projectDuration(project);
    const visibleSeconds = this.scroll.clientWidth / z;
    const totalSeconds = Math.max(duration + visibleSeconds * 0.5, visibleSeconds);
    this.content.style.width = `${totalSeconds * z}px`;

    this.renderRuler(totalSeconds);
    this.renderHeaders();

    const canvases = [];
    this.lanes.replaceChildren(
      ...laneOrder(project).map((track) => {
        const children =
          track.type === 'text'
            ? track.items.map((item) => this.renderTextItem(item))
            : track.clips.map((clip) => this.renderClip(track, clip, canvases));
        return h(`div.lane.${track.type}${track.muted ? '.muted' : ''}`, { dataset: { trackId: track.id } }, ...children);
      }),
      h('div.lane.add-row'),
    );
    // Canvases need layout before drawing.
    for (const draw of canvases) draw();
    this.renderPlayhead();
  }

  renderHeaders() {
    const project = store.project;
    const canRemove = tl.audioTracks(project).length > 1;
    const muteButton = (track, what) =>
      h(`button.icon${track.muted ? '.active' : ''}`, {
        title: track.muted ? `Unmute ${what}` : `Mute ${what}`,
        onclick: () => store.edit((p) => tl.setTrackMuted(p, track.id, !track.muted)),
      }, track.muted ? '🔇' : '🔊');

    this.headers.replaceChildren(
      ...laneOrder(project).map((track) => {
        if (track.type === 'text') return h('div.track-header.text', {}, 'Text');
        if (track.type === 'video') return h('div.track-header.video', {}, 'Video');
        return h('div.track-header.audio', {},
          h('span', {}, track.id.toUpperCase()),
          muteButton(track, 'track'),
          canRemove && !track.clips.length
            ? h('button.icon', { title: 'Remove empty track', onclick: () => store.edit((p) => tl.removeAudioTrack(p, track.id)) }, '✕')
            : null,
        );
      }),
      h('div.track-header.add-row', {},
        h('button.small', { title: 'Add an audio track', onclick: () => store.edit((p) => tl.addAudioTrack(p)) }, '+ Audio track')),
    );
  }

  /** '.selected' for the selected clip, and for its partners when selected together with them. */
  selectionClass(clip) {
    const sel = store.selection;
    if (sel?.kind !== 'clip') return '';
    if (sel.id === clip.id) return '.selected';
    const selected = tl.findClip(store.project, sel.id);
    if (!selected?.linkId || selected.linkId !== clip.linkId) return '';
    return selectsLinked(store.project, sel) ? '.selected' : '';
  }

  renderClip(track, clip, canvases) {
    const project = store.project;
    const media = tl.findMedia(project, clip.mediaId);
    const z = store.zoom;
    const cls = this.selectionClass(clip);
    const style = { left: `${this.x(clip.start)}px`, width: `${Math.max(2, this.x(tl.clipDuration(clip)))}px` };
    const linkMark = clip.linkId ? h('span.link-mark', { title: 'Linked — moves with its partner. Unlink with D.' }, '🔗') : null;

    if (track.type === 'video') {
      const thumbs = h('div.clip-thumbs');
      if (media?.thumbPath) {
        // Map the thumbnail strip onto source time so frames line up with content.
        Object.assign(thumbs.style, {
          backgroundImage: `url("${mediaUrl(media.thumbPath)}")`,
          backgroundSize: `${media.duration * z}px 100%`,
          backgroundPosition: `${-clip.in * z}px 0`,
        });
      }
      const tip = clip.linkId ? `${media?.name}\nClick: select with its sound · Ctrl+click: video only` : media?.name;
      return h(`div.clip.video${cls}`, { dataset: { id: clip.id }, style, title: tip },
        thumbs,
        h('div.handle.in', { dataset: { edge: 'in' } }),
        h('div.clip-label', {}, linkMark, media?.name ?? 'Missing media'),
        h('div.handle.out', { dataset: { edge: 'out' } }),
      );
    }

    const silent = clip.muted || track.muted;
    const canvas = h('canvas.wave');
    const peaks = getPeaks(media);
    if (peaks) canvases.push(() => drawWaveform(canvas, peaks, clip, z, { color: silent ? '#5b6272' : '#7fd3a8', fades: true }));
    const fadeInX = Math.min(this.x(clip.fadeIn), this.x(tl.clipDuration(clip)));
    const fadeOutX = Math.min(this.x(clip.fadeOut), this.x(tl.clipDuration(clip)));
    const label = h('div.clip-label', {}, linkMark, media?.name ?? 'Missing media',
      clip.muted ? h('span.badge', {}, 'muted') : clip.volume !== 1 ? h('span.badge', {}, `${Math.round(clip.volume * 100)}%`) : null);
    return h(`div.clip.audio${cls}${clip.muted ? '.muted' : ''}`, { dataset: { id: clip.id }, style, title: media?.name },
      canvas,
      h('div.handle.in', { dataset: { edge: 'in' } }),
      label,
      h('div.fade-handle', { dataset: { fade: 'in' }, style: { left: `${fadeInX}px` }, title: 'Drag to fade in' }),
      h('div.fade-handle', { dataset: { fade: 'out' }, style: { right: `${fadeOutX}px` }, title: 'Drag to fade out' }),
      h('div.handle.out', { dataset: { edge: 'out' } }),
    );
  }

  renderTextItem(item) {
    const sel = store.selection;
    const selected = sel?.kind === 'text' && sel.id === item.id;
    return h(`div.text-item${selected ? '.selected' : ''}`, {
      dataset: { id: item.id },
      style: { left: `${this.x(item.start)}px`, width: `${Math.max(2, this.x(item.end - item.start))}px` },
      title: item.text,
    },
      h('div.handle.in', { dataset: { edge: 'in' } }),
      h('div.clip-label', {}, item.text || '(empty)'),
      h('div.handle.out', { dataset: { edge: 'out' } }),
    );
  }

  renderRuler(totalSeconds) {
    const z = store.zoom;
    const step = TICK_STEPS.find((s) => s * z >= 80) ?? 600;
    const ticks = [];
    for (let t = 0; t <= totalSeconds; t += step) {
      ticks.push(h('div.tick', { style: { left: `${t * z}px` } }, step < 1 ? formatDuration(t) : formatDuration(t).replace(/\.0$/, '')));
    }
    this.ruler.replaceChildren(...ticks);
  }

  renderPlayhead() {
    const x = this.x(store.playhead);
    this.playheadEl.style.transform = `translateX(${x}px)`;
    // Keep the playhead visible during playback.
    const { scrollLeft, clientWidth } = this.scroll;
    if (this.playing && (x < scrollLeft || x > scrollLeft + clientWidth - 20)) {
      this.scroll.scrollLeft = Math.max(0, x - 40);
    }
  }

  /** Snap time t to the nearest candidate within SNAP_PX (playhead, clip edges outside the dragged link group). */
  snap(t, excludeId) {
    const threshold = SNAP_PX / store.zoom;
    const candidates = [0, store.playhead];
    const dragged = tl.findClip(store.project, excludeId);
    const exclude = new Set(tl.linkGroup(store.project, dragged).map((c) => c.id).concat(excludeId));
    for (const track of tl.clipTracks(store.project)) {
      for (const c of track.clips) if (!exclude.has(c.id)) candidates.push(c.start, tl.clipEnd(c));
    }
    let best = t;
    let bestDist = threshold;
    for (const c of candidates) {
      const d = Math.abs(c - t);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  }

  onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const itemEl = e.target.closest('.clip, .text-item');
    const handle = e.target.closest('.handle');
    const fadeHandle = e.target.closest('.fade-handle');
    const t = this.timeAt(e.clientX);
    this.content.setPointerCapture(e.pointerId);

    if (!itemEl) {
      if (!e.target.closest('.ruler')) store.select(null);
      this.gesture = { type: 'scrub' };
      store.setPlayhead(t);
      return;
    }

    const id = itemEl.dataset.id;
    const kind = itemEl.classList.contains('text-item') ? 'text' : 'clip';
    const item = kind === 'clip' ? tl.findClip(store.project, id) : tl.findText(store.project, id);
    // A plain click on a linked video clip selects its sound too; Ctrl+click selects the video alone.
    // Clicking a sound clip selects just the sound.
    store.select({ kind, id, withLinked: e.ctrlKey && kind === 'clip' ? false : undefined });
    const start = item.start;
    const end = kind === 'clip' ? tl.clipEnd(item) : item.end;

    this.gesture = {
      type: fadeHandle ? 'fade' : handle ? 'trim' : 'move',
      kind, id,
      isAudio: itemEl.classList.contains('audio'),
      edge: handle?.dataset.edge ?? fadeHandle?.dataset.fade,
      downX: e.clientX,
      downY: e.clientY,
      grabOffset: t - start,
      length: end - start,
      active: Boolean(handle || fadeHandle),
    };
    if (this.gesture.active) store.beginGesture();
  }

  onPointerMove(e) {
    const g = this.gesture;
    if (!g) return;
    const t = this.timeAt(e.clientX);
    if (g.type === 'scrub') {
      store.setPlayhead(t);
      return;
    }
    if (!g.active) {
      const dx = Math.abs(e.clientX - g.downX);
      const dy = g.isAudio ? Math.abs(e.clientY - g.downY) : 0; // audio clips may start a drag vertically
      if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
      g.active = true;
      store.beginGesture();
    }

    if (g.type === 'fade') {
      store.preview((p) => {
        const clip = tl.findClip(p, g.id);
        if (g.edge === 'in') tl.setClipFades(p, g.id, { fadeIn: Math.max(0, t - clip.start) });
        else tl.setClipFades(p, g.id, { fadeOut: Math.max(0, tl.clipEnd(clip) - t) });
      });
    } else if (g.type === 'move') {
      let start = t - g.grabOffset;
      // Snap either the leading or the trailing edge, whichever is closer.
      const snappedStart = this.snap(start, g.id);
      const snappedEnd = this.snap(start + g.length, g.id) - g.length;
      if (snappedStart !== start && Math.abs(snappedStart - start) <= Math.abs(snappedEnd - start)) start = snappedStart;
      else if (snappedEnd !== start) start = snappedEnd;
      start = Math.max(0, start);
      if (g.kind === 'clip') {
        // Audio clips follow the pointer to another audio lane.
        const lane = g.isAudio ? document.elementFromPoint(e.clientX, e.clientY)?.closest('.lane.audio') : null;
        store.preview((p) => tl.moveClip(p, g.id, start, lane?.dataset.trackId ?? null));
      } else {
        store.preview((p) => tl.updateText(p, g.id, { start, end: start + g.length }));
      }
    } else {
      const edgeT = this.snap(t, g.id);
      if (g.kind === 'clip') store.preview((p) => tl.trimClip(p, g.id, g.edge, edgeT));
      else store.preview((p) => {
        const item = tl.findText(p, g.id);
        if (g.edge === 'in') tl.updateText(p, g.id, { start: Math.min(edgeT, item.end - 0.05) });
        else tl.updateText(p, g.id, { end: Math.max(edgeT, item.start + 0.05) });
      });
    }
  }

  onPointerUp(e) {
    if (this.content.hasPointerCapture(e.pointerId)) this.content.releasePointerCapture(e.pointerId);
    if (this.gesture?.active) store.endGesture();
    this.gesture = null;
  }

  onWheel(e) {
    if (e.ctrlKey) {
      // Zoom around the cursor.
      e.preventDefault();
      const t = this.timeAt(e.clientX);
      const offset = e.clientX - this.scroll.getBoundingClientRect().left;
      store.setZoom(store.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
      this.scroll.scrollLeft = t * store.zoom - offset;
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !this.canScrollVertically()) {
      e.preventDefault();
      this.scroll.scrollLeft += e.deltaY;
    }
  }

  canScrollVertically() {
    const body = this.scroll.closest('.timeline-body');
    return body.scrollHeight > body.clientHeight + 1;
  }
}
