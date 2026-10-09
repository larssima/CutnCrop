# Changelog

All notable changes to CutnCrop. Versions follow [semantic versioning](https://semver.org):
MAJOR for incompatible project-file or behavior changes, MINOR for new features, PATCH for fixes.

## 0.3.1 — 2026-10-09

- Fix: playback stalled (the picture jumped back and forth) at the end of a clip that
  ends where its file ends — always the case for reversed clips, and for untrimmed clips.
- Smoother cuts in the preview: the next clip's file is preloaded in a second player
  and swapped in at the cut, instead of being loaded at the cut.

## 0.3.0 — 2026-10-09

- Effects, starting with **Reverse**: right-click a clip → Effects → Reverse (or the
  Effects checkboxes in the right-hand panel). Linked video and sound are reversed together.
  Export reverses in memory-bounded chunks; the preview shows exact reversed frames while
  paused and plays a background-rendered reversed file.
- Project files are now schema v4 (`effects` on clips); older projects upgrade on open.
- Copy, cut and paste (Ctrl+C / Ctrl+X / Ctrl+V): a video clip is copied with its sound.
  Ctrl+V pastes right after the selected clip (later clips move to make room) or at the end
  when nothing is selected; Ctrl+Shift+V pastes at the playhead (splitting a clip under it);
  right-click empty lane space → Paste here. Pasting works across projects.
- ↑ / ↓ jump the playhead to the previous / next cut between clips.
- Images on the timeline (JPG, PNG, WebP, BMP, GIF, TIFF; HEIC if FFmpeg supports it).
  New image clips show for a default 5 s (Project panel: "New images show for"); set the
  length by dragging either edge, the "Show for" field, or the right-click menu (2/3/5/10 s).
  Images are scaled to fit like video; PNG transparency becomes black.
- Dragging a clip's left edge now stops at the previous clip instead of pushing it aside.
- Project files are now schema v5 (`isImage` on media, `settings.imageDuration`).
- Dragging a media file onto a video clip shows an insertion line at the clip's nearer edge
  and inserts it there; sound never pushes other clips (it goes to a lane with room).

## 0.2.0 — 2026-10-01

- Source monitor: click a file in the Media panel to watch and scrub it in the preview
  without adding it to the timeline (Esc or "Back to timeline" returns).
- Right-click menus for clips, text and media files (split, duplicate, unlink, mute,
  fades, go to start/end, preview source, show in Explorer, delete variants).
- Duplicate (Ctrl+D) for clips (with their linked sound) and text.
- Close gaps without dragging: Ctrl+← moves the selected clip to the end of the previous
  clip, Ctrl+→ to the start of the next one; right-click a gap → "Close gap" pulls
  everything after it left.
- Keyboard & mouse shortcut chart: Help › Keyboard Shortcuts, F1, ? or the ? button.
- Fix: scrubbing right after pausing could leave the previous frame on screen.

## 0.1.0 — 2026-09-29

First release.

- Import video and audio files (file picker or drag and drop), with background proxies,
  thumbnails and waveforms.
- Timeline with a video lane, audio lanes and a text lane: arrange, trim, split, delete,
  snapping, zoom, undo/redo.
- Clip sound on audio lanes, linked to its video (Ctrl+click selects the video alone,
  D unlinks, M mutes), fades, track mute.
- Text overlays with position, size and color.
- Preview playback with scrubbing and frame stepping.
- Export to MP4 (H.264/AAC) with progress and cancel; frame- and sample-exact A/V sync,
  also in players that ignore MP4 edit lists.
- Save/open projects (`.cutncrop`, schema v3; older files are upgraded on open).
- Windows installer and portable zip with bundled FFmpeg.
