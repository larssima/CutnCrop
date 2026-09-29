import { store } from './store.js';
import { $, isTyping, toast } from './util.js';
import { Preview } from './preview.js';
import { TimelineView } from './timelineView.js';
import { MediaBin, importPaths, prepare, listenForMediaUpdates } from './media.js';
import { Inspector } from './inspector.js';
import { ExportDialog } from './exportDialog.js';
import * as tl from '../../shared/timeline.js';
import { createProject } from '../../shared/schema.js';
import { formatTimecode, frameDuration } from '../../shared/time.js';

const preview = new Preview($('#preview'));
const timeline = new TimelineView($('#timeline'));
new MediaBin($('#media-bin'));
new Inspector($('#inspector'));
const exportDialog = new ExportDialog($('#export-dialog'));
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

/** The clip to split: the selected one if the playhead is over it, else the video clip under the playhead. */
function clipToSplit() {
  const s = store.selection;
  const t = store.playhead;
  const selected = s?.kind === 'clip' ? tl.findClip(store.project, s.id) : null;
  if (selected && t > selected.start && t < tl.clipEnd(selected)) return selected;
  return tl.clipAt(store.project, t);
}

function step(frames) {
  preview.pause();
  store.setPlayhead(store.playhead + frames * frameDuration(store.project.settings.fps));
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
  start: () => store.setPlayhead(0),
  end: () => store.setPlayhead(tl.projectDuration(store.project)),
  prevFrame: () => step(-1),
  nextFrame: () => step(1),
};

function run(name) {
  const fn = commands[name];
  if (!fn) return;
  Promise.resolve(fn()).catch((e) => toast(e.message, { error: true }));
}

window.api.onCommand((name) => {
  // Menu undo/redo in a text field means text undo.
  if ((name === 'undo' || name === 'redo') && isTyping()) return document.execCommand(name);
  run(name);
});
store.on('command', run);

for (const btn of document.querySelectorAll('[data-command]')) {
  btn.addEventListener('click', () => run(btn.dataset.command));
}

// ---- Keyboard --------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !isTyping()) {
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) run('undo');
    else if (key === 'y' || (key === 'z' && e.shiftKey)) run('redo');
    else return;
    e.preventDefault();
    return;
  }
  if (ctrl || isTyping() || e.altKey) return;
  const map = {
    ' ': 'play', k: 'play',
    s: 'split', t: 'addText', d: 'unlink', m: 'toggleMute',
    Delete: e.shiftKey ? 'rippleDelete' : 'delete', Backspace: 'delete',
    Home: 'start', End: 'end',
    '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '\\': 'zoomFit',
  };
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    step(dir * (e.shiftKey ? Math.round(store.project.settings.fps) : 1));
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
  window.api.setTitle(`${store.dirty ? '• ' : ''}${name} — CutnCrop`);
}
store.on('dirty', updateTitle);
store.on('project', updateTitle);

function updateTimecode() {
  const { fps } = store.project.settings;
  $('#timecode').textContent = formatTimecode(store.playhead, fps);
  $('#duration').textContent = formatTimecode(tl.projectDuration(store.project), fps);
}
store.on('playhead', updateTimecode);
store.on('project', updateTimecode);
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

updateTitle();
updateTimecode();
updateUndoButtons();
store.emit('zoom');
