// Application state: the project (with undo/redo), selection, playhead and
// transient media status. Views subscribe to events and re-render.
//
// Edits:  store.edit(p => timeline.splitClip(p, id, t))   one undo step
// Drags:  store.beginGesture(); store.preview(fn) on every move; store.endGesture()
//         Each preview re-applies fn to the snapshot taken at gesture start.

import { createProject } from '../../shared/schema.js';
import { projectDuration } from '../../shared/timeline.js';

const HISTORY_LIMIT = 200;

class Store extends EventTarget {
  constructor() {
    super();
    this.project = createProject();
    this.filePath = null;
    this.dirty = false;
    // { kind: 'clip' | 'text' | 'media', id, withLinked? } — withLinked: false
    // when a video clip was Ctrl+clicked to select it without its sound.
    this.selection = null;
    this.playhead = 0;
    this.zoom = 60; // timeline pixels per second
    this.mediaStatus = new Map(); // mediaId -> { proxyProgress, error }
    this.undoStack = [];
    this.redoStack = [];
    this.gestureBase = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  setProject(project, filePath = null) {
    this.project = project;
    this.filePath = filePath;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.playhead = 0;
    this.mediaStatus.clear();
    this.setDirty(false);
    this.emit('project');
    this.emit('selection');
    this.emit('playhead');
  }

  setDirty(value) {
    this.dirty = value;
    window.api.setDirty(value);
    this.emit('dirty');
  }

  pushUndo(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Apply one undoable edit. Returns fn's result. */
  edit(fn) {
    const before = JSON.stringify(this.project);
    const result = fn(this.project);
    if (JSON.stringify(this.project) !== before) {
      this.pushUndo(before);
      this.changed();
    }
    return result;
  }

  /** Update fields that aren't user edits (e.g. proxy paths): no undo step, no dirty flag. */
  patchSilently(fn) {
    fn(this.project);
    for (const snap of [this.undoStack, this.redoStack]) {
      // Keep history snapshots consistent so undo doesn't drop proxy paths.
      for (let i = 0; i < snap.length; i++) {
        const p = JSON.parse(snap[i]);
        fn(p);
        snap[i] = JSON.stringify(p);
      }
    }
    this.emit('project');
  }

  beginGesture() {
    this.gestureBase = JSON.stringify(this.project);
  }

  preview(fn) {
    if (this.gestureBase === null) this.beginGesture();
    this.project = JSON.parse(this.gestureBase);
    const result = fn(this.project);
    this.emit('project');
    return result;
  }

  endGesture() {
    if (this.gestureBase === null) return;
    if (JSON.stringify(this.project) !== this.gestureBase) {
      this.pushUndo(this.gestureBase);
      this.changed();
    }
    this.gestureBase = null;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.undoStack.pop());
    this.changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.redoStack.pop());
    this.changed();
  }

  changed() {
    this.validateSelection();
    if (!this.dirty) this.setDirty(true);
    this.emit('project');
  }

  validateSelection() {
    const s = this.selection;
    if (!s) return;
    const p = this.project;
    const exists =
      (s.kind === 'media' && p.media.some((m) => m.id === s.id)) ||
      (s.kind === 'clip' && p.tracks.some((t) => t.clips?.some((c) => c.id === s.id))) ||
      (s.kind === 'text' && p.tracks.some((t) => t.items?.some((x) => x.id === s.id)));
    if (!exists) this.select(null);
  }

  select(selection) {
    const same =
      selection?.id === this.selection?.id &&
      selection?.kind === this.selection?.kind &&
      Boolean(selection?.withLinked) === Boolean(this.selection?.withLinked);
    if (same) return;
    this.selection = selection;
    this.emit('selection');
  }

  setPlayhead(t) {
    const clamped = Math.max(0, Math.min(t, Math.max(projectDuration(this.project), 0)));
    if (clamped === this.playhead) return;
    this.playhead = clamped;
    this.emit('playhead');
  }

  setZoom(pxPerSecond) {
    this.zoom = Math.max(2, Math.min(600, pxPerSecond));
    this.emit('zoom');
  }

  setMediaStatus(id, patch) {
    this.mediaStatus.set(id, { ...this.mediaStatus.get(id), ...patch });
    this.emit('media-status', id);
  }
}

export const store = new Store();
