# Changelog

All notable changes to CutnCrop. Versions follow [semantic versioning](https://semver.org):
MAJOR for incompatible project-file or behavior changes, MINOR for new features, PATCH for fixes.

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
