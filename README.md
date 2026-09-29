# CutnCrop

A desktop video editor for Windows, built on Electron and native ffmpeg.
See [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for goals and roadmap, and
[docs/project-schema.md](docs/project-schema.md) for the project file format.

## Getting started

Requires Node 20+ and ffmpeg/ffprobe (on PATH, in `vendor/ffmpeg/`, or in `CUTNCROP_FFMPEG_DIR`).

```bash
npm install
npm start          # launch the app
npm test           # unit + export integration tests (generates test-media/ on first run)
npm run drive-ui   # scripted end-to-end UI run with screenshots in test-output/ui/
npm run dist       # bundle ffmpeg and build the Windows installer
```

## Layout

```
src/shared/     project schema, timeline edit operations, frame/time math (used by main and renderer)
src/main/       Electron main process: window, IPC, media:// protocol, ffmpeg, proxies, export
  export/       buildCommand.js turns a project into an ffmpeg filter graph (pure, unit-testable)
src/renderer/   UI: store (state + undo), preview player, timeline, media bin, inspector, export dialog
scripts/        test-media generator, UI driver, launcher, ffmpeg vendoring
test/           unit tests and ffprobe-verified export tests
```

## How export works

The timeline is cut into segments (clips and gaps), counted in whole frames.
Each clip is read from its source with an input seek, conformed to the project
fps, size and audio format, and forced to an exact frame count. Its audio is
padded or trimmed to the matching sample count. The segments are then
concatenated and text is drawn on top. Because every segment's audio length is
derived from the same frame boundaries as its video, A/V sync can't drift.
The `sync` integration test checks this by matching flash frames against beeps
in the exported file.

All sound lives on audio tracks. Each audio clip is cut to an exact sample
count, faded, delayed by an exact number of samples to its timeline position,
and summed over a silent bed (`amix` with normalization off, so adding tracks
doesn't change levels). The tests in `test/integration/audio.test.js` check
linked, unlinked and moved audio against the flashes, the mix level, fades and muting.

## Audio

- A video's sound is placed on an audio track (A1 when free) as a separate clip, **linked** (🔗)
  to the video: they move, trim and split together.
- **Click** a video clip to select it with its sound; **Ctrl+click** selects the video alone.
  Clicking a sound clip selects just the sound. **Delete** removes what is selected; whatever is
  left of a linked pair becomes unlinked.
- **D** unlinks the selected clip; then the sound can be moved or deleted on its own, e.g. to
  replace it with music. **M** mutes the selected clip's sound.
- Audio files (mp3, wav, m4a, flac, ogg, …) go on audio tracks. Drop them on a lane, or double-click
  them in the media bin. If that lane is busy there, they go to the first lane with room. Drag audio
  clips between lanes; add lanes with **+ Audio track**.
- Drag the round handles at the top corners of an audio clip to set fade in/out.
- The speaker buttons in the track headers mute a whole track.

## Keyboard

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Previous / next frame (Shift: 1 second) |
| Home / End | Go to start / end |
| S | Split at playhead |
| T | Add text at playhead |
| D | Unlink the selected clip's video and audio |
| M | Mute / unmute the selected clip's sound |
| Del | Delete selection (Shift+Del: ripple delete) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| + / − / \ | Zoom in / out / fit (Ctrl+wheel zooms at the cursor) |
| Ctrl+I / Ctrl+E | Import / export |
| Ctrl+N / O / S | New / open / save project |
