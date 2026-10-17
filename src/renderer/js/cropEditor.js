// Crop mode on the preview: the clip's full picture is shown with a crop
// rectangle on top. Drag its edges or corners to crop, drag inside it to move
// it; the area outside is dimmed. Each drag is one undo step.

import { store } from './store.js';
import { h } from './util.js';
import * as tl from '../../shared/timeline.js';
import { cropOf } from '../../shared/transform.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export class CropEditor {
  constructor(frame) {
    this.box = h('div.crop-box', {},
      ...HANDLES.map((d) => h(`div.crop-handle.${d}`, { dataset: { drag: d } })),
      h('div.crop-size'));
    this.overlay = h('div.crop-overlay', { hidden: true }, this.box);
    this.bar = h('div.crop-bar', { hidden: true },
      h('span', {}, 'Crop: drag the edges or corners, drag inside to move'),
      h('button.primary', { onclick: () => store.setCropEdit(null), title: 'Finish cropping (Enter / Esc)' }, 'Done'));
    frame.append(this.overlay, this.bar);
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  /** Show the editor for `clip`, over `rect` (the full picture's rectangle in the frame, px). */
  show(clip, rect) {
    this.clipId = clip.id;
    this.rect = rect;
    Object.assign(this.overlay.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    const c = cropOf(clip);
    Object.assign(this.box.style, {
      left: `${c.left * 100}%`, right: `${c.right * 100}%`, top: `${c.top * 100}%`, bottom: `${c.bottom * 100}%`,
    });
    const media = tl.findMedia(store.project, clip.mediaId);
    const w = Math.round(media.width * (1 - c.left - c.right));
    const hgt = Math.round(media.height * (1 - c.top - c.bottom));
    this.box.querySelector('.crop-size').textContent = `${w} × ${hgt}`;
    this.overlay.hidden = false;
    this.bar.hidden = false;
  }

  hide() {
    this.overlay.hidden = true;
    this.bar.hidden = true;
    this.drag = null;
  }

  onDown(e) {
    if (e.button !== 0) return;
    const clip = tl.findClip(store.project, this.clipId);
    if (!clip) return;
    const handle = e.target.dataset.drag;
    // Inside the rectangle moves it; elsewhere on the picture does nothing.
    const kind = handle ?? (e.target === this.box || this.box.contains(e.target) ? 'move' : null);
    if (!kind) return;
    e.preventDefault();
    this.overlay.setPointerCapture(e.pointerId);
    this.drag = { kind, x: e.clientX, y: e.clientY, start: { ...cropOf(clip) } };
    store.beginGesture();
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    const dx = (e.clientX - d.x) / this.rect.width;
    const dy = (e.clientY - d.y) / this.rect.height;
    const s = d.start;
    const crop = { ...s };
    let keep = null;
    if (d.kind === 'move') {
      // Slide the rectangle without changing its size, within the picture.
      const mx = Math.min(Math.max(dx, -s.left), s.right);
      const my = Math.min(Math.max(dy, -s.top), s.bottom);
      Object.assign(crop, { left: s.left + mx, right: s.right - mx, top: s.top + my, bottom: s.bottom - my });
    } else {
      if (d.kind.includes('w')) [crop.left, keep] = [s.left + dx, 'left'];
      if (d.kind.includes('e')) [crop.right, keep] = [s.right - dx, 'right'];
      if (d.kind.includes('n')) crop.top = s.top + dy;
      if (d.kind.includes('s')) crop.bottom = s.bottom - dy;
      if (d.kind === 'n' || d.kind === 's') keep = d.kind === 'n' ? 'top' : 'bottom';
    }
    store.preview((p) => tl.setCrop(p, this.clipId, crop, keep));
  }

  onUp(e) {
    if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
    if (this.drag) store.endGesture();
    this.drag = null;
  }
}
