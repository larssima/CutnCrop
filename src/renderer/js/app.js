import { store } from './store.js';
import { $, isTyping, toast } from './util.js';
import { Preview } from './preview.js';
import { TimelineView } from './timelineView.js';
import { MediaBin, importPaths, prepare, listenForMediaUpdates } from './media.js';
import { Inspector } from './inspector.js';
import { ExportDialog } from './exportDialog.js';
import { ShortcutsDialog } from './shortcuts.js';
import { showItemMenu } from './clipMenus.js';
import { isContextMenuOpen } from './contextMenu.js';
import { copySelection, cutSelection, paste } from './clipboard.js';
import * as tl from '../../shared/timeline.js';
import { createProject } from '../../shared/schema.js';
import { formatTimecode, frameDuration } from '../../shared/time.js';

const preview = new Preview($('#preview'));
const timeline = new TimelineView($('#timeline'));
new MediaBin($('#media-bin'));
new Inspector($('#inspector'));
const exportDialog = new ExportDialog($('#export-dialog'));
const shortcutsDialog = new ShortcutsDialog($('#shortcuts-dialog'));
listenForMediaUpdates();
// Handle for scripted UI runs (scripts/drive-ui.mjs) and DevTools debugging.
window.cutncrop = { store, preview };

// ---- Commands -------------------------------------------------------------

function confirmDiscard() {
  return !store.dirty || window.confirm('Discard unsaved changes to the current project?');
}

async function save(saveAs = false) {
  const filePath = await window.api.saveProject({ project: store.project, filePath: store.filePath, saveAs });
  if (!filePath) return false;
  store.filePath = filePath;
  store.setDirty(false);
  toast('Project saved');
  return true;
}

function selectedClip() {
  const s = store.selection;
  return s?.kind === 'clip' ? tl.findClip(store.project, s.id) : null;
}

/** Close the gap before (or after) the selected clip or text item by moving it. */
function moveAgainstNeighbor(direction) {
  const s = store.selection;
  if (s?.kind !== 'clip' && s?.kind !== 'text') return toast('Select a clip or text first.');
  const p = store.project;
  const item = s.kind === 'clip' ? tl.findClip(p, s.id) : tl.findText(p, s.id);
  const end = s.kind === 'clip' ? tl.clipEnd(item) : item.end;
  if (direction === 'previous') {
    if (item.start - tl.previousEnd(p, s.id) < 1e-6) return toast('No gap before this clip.');
    store.edit((proj) => tl.moveToPreviousEnd(proj, s.id));
  } else {
    const next = tl.nextStart(p, s.id);
    if (next === null || next - end < 1e-6) return toast('No gap after this clip.');
    store.edit((proj) => tl.moveToNextStart(proj, s.id));
  }
}

/** The clip to split: the selected one if the playhead is over it, else the video clip under the playhead. */
function clipToSplit() {
  const s = store.selection;
  const t = store.playhead;
  const selected = s?.kind === 'clip' ? tl.findClip(store.project, s.id) : null;
  if (selected && t > selected.start && t < tl.clipEnd(selected)) return selected;
  return tl.clipAt(store.project, t);
}

/** Move the playhead to the previous (-1) or next (+1) cut between clips. */
function jumpToCut(dir) {
  preview.pause();
  const now = store.playhead;
  const points = tl.cutPoints(store.project);
  const target = dir < 0 ? points.filter((t) => t < now - 1e-6).at(-1) : points.find((t) => t > now + 1e-6);
  if (target !== undefined) store.setPlayhead(target);
}

/** The media file shown in the source monitor, or null when the preview shows the timeline. */
function sourceMedia() {
  return store.source ? tl.findMedia(store.project, store.source.mediaId) : null;
}

/** Frame rate for stepping and timecode: the source file's, or the project's. */
function activeFps() {
  return sourceMedia()?.fps || store.project.settings.fps;
}

/** Move the active time (source or timeline) by whole frames. */
function step(frames) {
  preview.pause();
  const delta = frames * frameDuration(activeFps());
  if (store.source) store.setSourceTime(store.source.time + delta);
  else store.setPlayhead(store.playhead + delta);
}

const commands = {
  new: () => {
    if (confirmDiscard()) store.setProject(createProject());
  },
  open: async () => {
    if (!confirmDiscard()) return;
    try {
      const result = await window.api.openProject();
      if (!result) return;
      store.setProject(result.project, result.filePath);
      prepare(result.project.media.filter((m) => !result.missing.includes(m.path)));
      if (result.missing.length) toast(`Missing media files:\n${result.missing.join('\n')}`, { error: true, ms: 8000 });
      timeline.zoomToFit();
    } catch (e) {
      toast(`Couldn't open project: ${e.message}`, { error: true });
    }
  },
  save: () => save(false),
  saveAs: () => save(true),
  import: async () => importPaths(await window.api.pickMedia()),
  export: () => exportDialog.open(),
  undo: () => store.undo(),
  redo: () => store.redo(),
  play: () => preview.togglePlay(),
  split: () => {
    const clip = clipToSplit();
    if (!clip) return;
    const right = store.edit((p) => tl.splitClip(p, clip.id, store.playhead));
    if (right) store.select({ kind: 'clip', id: right.id });
  },
  delete: (ripple = false) => {
    const s = store.selection;
    if (!s) return;
    if (s.kind === 'clip') store.edit((p) => tl.deleteClip(p, s.id, { ripple, withLinked: s.withLinked }));
    else if (s.kind === 'text') store.edit((p) => tl.deleteText(p, s.id));
    else if (s.kind === 'media') {
      const uses = tl.clipTracks(store.project).flatMap((t) => t.clips).filter((c) => c.mediaId === s.id).length;
      if (uses && !window.confirm(`This media is used by ${uses} clip(s) on the timeline. Remove it and those clips?`)) return;
      store.edit((p) => tl.removeMedia(p, s.id));
    }
    store.select(null);
  },
  rippleDelete: () => commands.delete(true),
  addText: () => {
    const t = store.playhead;
    const item = store.edit((p) => tl.addText(p, { start: t, end: t + 3, text: 'Your text' }));
    store.select({ kind: 'text', id: item.id });
  },
  closeGaps: () => store.edit((p) => tl.closeGaps(p)),
  duplicate: () => {
    const s = store.selection;
    if (s?.kind === 'clip') {
      const copy = store.edit((p) => tl.duplicateClip(p, s.id));
      store.select({ kind: 'clip', id: copy.id, withLinked: s.withLinked });
    } else if (s?.kind === 'text') {
      const copy = store.edit((p) => tl.duplicateText(p, s.id));
      store.select({ kind: 'text', id: copy.id });
    }
  },
  shortcuts: () => shortcutsDialog.open(),
  copy: () => copySelection(),
  cut: () => cutSelection(),
  paste: () => paste('auto'),
  pasteAtPlayhead: () => paste('playhead'),
  prevCut: () => jumpToCut(-1),
  nextCut: () => jumpToCut(1),
  moveToPrevious: () => moveAgainstNeighbor('previous'),
  moveToNext: () => moveAgainstNeighbor('next'),
  unlink: () => {
    const clip = selectedClip();
    if (!clip?.linkId) return toast('Select a linked clip (marked 🔗) to unlink its video and audio.');
    store.edit((p) => tl.unlinkClip(p, clip.id));
    toast('Unlinked — the video and its audio can now be moved or deleted separately.');
  },
  toggleMute: () => {
    const clip = selectedClip();
    if (!clip) return toast('Select a clip to mute it.');
    const audio = tl.audioClipsOf(store.project, clip);
    if (!audio.length) return toast('This clip has no audio.');
    store.edit((p) => tl.setClipMuted(p, clip.id, !audio[0].muted));
  },
  zoomIn: () => store.setZoom(store.zoom * 1.5),
  zoomOut: () => store.setZoom(store.zoom / 1.5),
  zoomFit: () => timeline.zoomToFit(),
  start: () => (store.source ? store.setSourceTime(0) : store.setPlayhead(0)),
  end: () => (store.source ? store.setSourceTime(sourceMedia().duration) : store.setPlayhead(tl.projectDuration(store.project))),
  closeSource: () => store.closeSource(),
  prevFrame: () => step(-1),
  nextFrame: () => step(1),
};

function run(name) {
  const fn = commands[name];
  if (!fn) return;
  Promise.resolve(fn()).catch((e) => toast(e.message, { error: true }));
}

window.api.onCommand((name) => {
  // Menu undo/redo/copy/cut/paste in a text field act on the text.
  if (['undo', 'redo', 'copy', 'cut', 'paste'].includes(name) && isTyping()) return document.execCommand(name);
  run(name);
});
store.on('command', run);
store.on('context-menu', (target) => showItemMenu(target, run));

for (const btn of document.querySelectorAll('[data-command]')) {
  btn.addEventListener('click', () => run(btn.dataset.command));
}

// ---- Keyboard --------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    run('shortcuts');
    return;
  }
  // Dialogs and popup menus own the keyboard while open.
  if (document.querySelector('dialog[open]') || isContextMenuOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !isTyping()) {
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) run('undo');
    else if (key === 'y' || (key === 'z' && e.shiftKey)) run('redo');
    else if (key === 'd') run('duplicate');
    else if (key === 'c') run('copy');
    else if (key === 'x') run('cut');
    else if (key === 'v') run(e.shiftKey ? 'pasteAtPlayhead' : 'paste');
    else if (e.key === 'ArrowLeft') run('moveToPrevious');
    else if (e.key === 'ArrowRight') run('moveToNext');
    else return;
    e.preventDefault();
    return;
  }
  if (ctrl || isTyping() || e.altKey) return;
  const map = {
    ' ': 'play', k: 'play',
    s: 'split', t: 'addText', d: 'unlink', m: 'toggleMute',
    Delete: e.shiftKey ? 'rippleDelete' : 'delete', Backspace: 'delete',
    Home: 'start', End: 'end', Escape: 'closeSource', '?': 'shortcuts',
    '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '\\': 'zoomFit',
  };
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    run(e.key === 'ArrowUp' ? 'prevCut' : 'nextCut');
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    step(dir * (e.shiftKey ? Math.round(activeFps()) : 1));
    e.preventDefault();
    return;
  }
  const name = map[e.key] ?? map[e.key.toLowerCase()];
  if (name) {
    e.preventDefault();
    run(name);
  }
});

// ---- Drag & drop files from Explorer ---------------------------------------

document.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    document.body.classList.add('file-drag');
  }
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('file-drag');
});
document.addEventListener('drop', (e) => {
  document.body.classList.remove('file-drag');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
  const trackId = timeline.trackAt(e.target);
  importPaths(paths, trackId ? timeline.timeAt(e.clientX) : null, trackId).catch((err) => toast(err.message, { error: true }));
});

// ---- Status: title, timecode, play button ----------------------------------

function updateTitle() {
  const name = store.filePath ? store.filePath.split(/[\\/]/).pop() : 'Untitled';
  window.api.setTitle(`${store.dirty ? '• ' : ''}${name} — CutnCrop ${window.api.version}`);
}
store.on('dirty', updateTitle);
store.on('project', updateTitle);

function updateTimecode() {
  const fps = activeFps();
  const media = sourceMedia();
  $('#timecode').textContent = formatTimecode(media ? store.source.time : store.playhead, fps);
  $('#duration').textContent = formatTimecode(media ? media.duration : tl.projectDuration(store.project), fps);
  $('#timecode').classList.toggle('source', Boolean(media));
}
store.on('playhead', updateTimecode);
store.on('project', updateTimecode);
store.on('source', updateTimecode);
store.on('source-time', updateTimecode);
store.on('playstate', (playing) => {
  const btn = $('#play-button');
  btn.textContent = playing ? '❚❚' : '▶';
  btn.title = playing ? 'Pause (Space)' : 'Play (Space)';
});

function updateUndoButtons() {
  $('[data-command=undo]').disabled = !store.undoStack.length;
  $('[data-command=redo]').disabled = !store.redoStack.length;
}
store.on('project', updateUndoButtons);

$('#zoom-slider').addEventListener('input', (e) => store.setZoom(Math.pow(2, Number(e.target.value))));
store.on('zoom', () => ($('#zoom-slider').value = Math.log2(store.zoom)));

$('#export-dialog').addEventListener('cancel', (e) => {
  if (exportDialog.running) e.preventDefault();
});

$('#brand').title = `CutnCrop ${window.api.version} — Help › About for details`;
updateTitle();
updateTimecode();
updateUndoButtons();
store.emit('zoom');
