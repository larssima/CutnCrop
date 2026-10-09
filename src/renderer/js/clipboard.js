// Copy, cut and paste of clips and text. The clipboard is in-app (it holds a
// snapshot including the media entries), so it also works across projects.
//
// Where a paste goes:
//   'auto'     clip selected -> right after it (for video, later clips move to
//              make room); nothing selected -> end of the lane. Text -> at the playhead.
//   'playhead' at the playhead; a video clip under the playhead is split first.
// Sound-only pastes never push other clips; they go to an audio lane with room.
//   { at, trackId? } a specific time (right-click "Paste here"); later clips only
//              move if it doesn't fit in the empty space there.

import { store } from './store.js';
import { toast } from './util.js';
import { prepare } from './media.js';
import * as tl from '../../shared/timeline.js';

let clipboard = null;

export const hasClipboard = () => clipboard !== null;

export function copySelection() {
  const s = store.selection;
  const p = store.project;
  if (s?.kind === 'clip') clipboard = tl.copyClip(p, s.id, { withLinked: s.withLinked });
  else if (s?.kind === 'text') clipboard = tl.copyText(p, s.id);
  else return toast('Select a clip or text to copy.'), false;
  const n = clipboard.kind === 'clips' ? clipboard.clips.length : 1;
  toast(clipboard.kind === 'text' ? 'Text copied' : n > 1 ? 'Clip and its sound copied' : 'Clip copied');
  return true;
}

export function cutSelection() {
  const s = store.selection;
  if (!copySelection()) return;
  if (s.kind === 'clip') store.edit((p) => tl.deleteClip(p, s.id, { withLinked: s.withLinked }));
  else store.edit((p) => tl.deleteText(p, s.id));
  store.select(null);
}

export function paste(where = 'auto') {
  if (!clipboard) return toast('Nothing to paste — copy a clip first (Ctrl+C).');
  const before = new Set(store.project.media.map((m) => m.id));

  if (clipboard.kind === 'text') {
    const at = typeof where === 'object' ? where.at : store.playhead;
    const item = store.edit((p) => tl.pasteText(p, clipboard, at));
    store.select({ kind: 'text', id: item.id });
    return;
  }

  const main = clipboard.clips[0];
  const pasted = store.edit((p) => {
    const lane = main.trackType === 'video' ? tl.videoTrack(p) : tl.findTrack(p, main.trackId) ?? tl.audioTracks(p)[0];
    if (typeof where === 'object') {
      // Into empty space: only push later clips along if a video clip doesn't fit
      // there. Sound never pushes; it goes to a lane with room instead.
      const fits = main.trackType === 'audio' || tl.fitsOnTrack(lane, where.at, where.at + clipboard.duration);
      return tl.pasteClips(p, clipboard, where.at, { insert: !fits });
    }
    const selected = store.selection?.kind === 'clip' ? tl.findClip(p, store.selection.id) : null;
    // Sound on its own is placed, never inserted: it goes to a lane with room
    // rather than pushing the picture (and everything linked) along.
    const insert = main.trackType === 'video';
    if (where === 'playhead') {
      // Insert edit: split the video clip under the playhead, then make room.
      const under = insert && tl.clipAt(p, store.playhead, lane);
      if (under && store.playhead > under.start + 1e-6) tl.splitClip(p, under.id, store.playhead);
      return tl.pasteClips(p, clipboard, store.playhead, { insert });
    }
    if (selected) return tl.pasteClips(p, clipboard, tl.clipEnd(selected), { insert });
    return tl.pasteClips(p, clipboard, tl.trackEnd(lane));
  });
  store.select({ kind: 'clip', id: pasted.id });

  // Pasting into another project can bring new media along: make its previews.
  const added = store.project.media.filter((m) => !before.has(m.id));
  if (added.length) prepare(added);
}
