// Right-click menus for timeline clips, text items and media files. Items reuse
// the app's commands (passed in as `run`) so menus and shortcuts stay identical.

import { store } from './store.js';
import { showContextMenu } from './contextMenu.js';
import * as tl from '../../shared/timeline.js';

/** Open the menu for { kind: 'clip' | 'text' | 'media', id } at (x, y). */
export function showItemMenu({ kind, id, x, y }, run) {
  const items = kind === 'clip' ? clipItems(id, run) : kind === 'text' ? textItems(id, run) : mediaItems(id, run);
  if (items) showContextMenu(x, y, items);
}

function previewSource(mediaId, time = 0) {
  store.select({ kind: 'media', id: mediaId });
  store.openSource(mediaId);
  store.setSourceTime(time);
}

function clipItems(id, run) {
  const p = store.project;
  const clip = tl.findClip(p, id);
  if (!clip) return null;
  const media = tl.findMedia(p, clip.mediaId);
  const isVideo = tl.trackOfClip(p, id).type === 'video';
  const sound = tl.audioClipsOf(p, clip)[0];
  const end = tl.clipEnd(clip);
  const playheadInside = store.playhead > clip.start && store.playhead < end;
  const linkedVideo = isVideo && Boolean(clip.linkId);
  const hasFades = !isVideo && (clip.fadeIn > 0 || clip.fadeOut > 0);
  const fade = (changes) => store.edit((proj) => tl.setClipFades(proj, id, changes));

  return [
    { label: 'Split at playhead', shortcut: 'S', disabled: !playheadInside, action: () => run('split') },
    { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => run('duplicate') },
    '-',
    clip.linkId && { label: isVideo ? 'Unlink video and sound' : 'Unlink from video', shortcut: 'D', action: () => run('unlink') },
    sound && { label: sound.muted ? 'Unmute sound' : 'Mute sound', shortcut: 'M', action: () => run('toggleMute') },
    !isVideo && { label: 'Fade in 1 s', action: () => fade({ fadeIn: 1 }) },
    !isVideo && { label: 'Fade out 1 s', action: () => fade({ fadeOut: 1 }) },
    !isVideo && { label: 'Remove fades', disabled: !hasFades, action: () => fade({ fadeIn: 0, fadeOut: 0 }) },
    (clip.linkId || sound || !isVideo) && '-',
    { label: 'Go to clip start', action: () => store.setPlayhead(clip.start) },
    { label: 'Go to clip end', action: () => store.setPlayhead(end) },
    { label: 'Preview source file', action: () => previewSource(clip.mediaId, clip.in) },
    { label: 'Show file in Explorer', action: () => window.api.showItemInFolder(media.path) },
    '-',
    linkedVideo
      ? { label: 'Delete clip and its sound', shortcut: 'Del', danger: true, action: () => deleteClip(id, true) }
      : { label: 'Delete', shortcut: 'Del', danger: true, action: () => deleteClip(id, undefined) },
    linkedVideo && { label: 'Delete video only', shortcut: 'Ctrl+click, Del', danger: true, action: () => deleteClip(id, false) },
    isVideo && { label: 'Ripple delete', shortcut: 'Shift+Del', danger: true, action: () => run('rippleDelete') },
  ];
}

function deleteClip(id, withLinked) {
  store.edit((p) => tl.deleteClip(p, id, { withLinked }));
  store.select(null);
}

function textItems(id, run) {
  const item = tl.findText(store.project, id);
  if (!item) return null;
  return [
    { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => run('duplicate') },
    { label: 'Go to text start', action: () => store.setPlayhead(item.start) },
    '-',
    { label: 'Delete', shortcut: 'Del', danger: true, action: () => run('delete') },
  ];
}

function mediaItems(id, run) {
  const media = tl.findMedia(store.project, id);
  if (!media) return null;
  const addAt = (t) => {
    const clip = store.edit((p) => tl.addClip(p, id, t));
    store.select({ kind: 'clip', id: clip.id });
  };
  return [
    { label: 'Preview', shortcut: 'Click', action: () => previewSource(id) },
    { label: 'Add to end of timeline', shortcut: 'Double-click', action: () => addAt(null) },
    { label: 'Add at playhead', action: () => addAt(store.playhead) },
    { label: 'Show file in Explorer', action: () => window.api.showItemInFolder(media.path) },
    '-',
    { label: 'Remove from project', shortcut: 'Del', danger: true, action: () => run('delete') },
  ];
}
