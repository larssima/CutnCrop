# Video Editor – Project Brief

## Goal
Build a general-purpose desktop video editor for Windows. Start with a solid MVP, then grow toward multi-track editing, transitions, and effects.

## Why desktop, not web
Video editing needs fast disk access to large files, hardware-accelerated decoding, native ffmpeg, and freedom to cache proxies/thumbnails. Browsers limit all of these (file access, memory caps, slow ffmpeg.wasm, uneven WebCodecs support, throttled tabs during export).

## Stack
- **Shell:** Electron (preferred for simplicity; Node backend makes spawning ffmpeg easy). Tauri is the alternative if app size/performance becomes a concern (Rust backend).
- **UI:** HTML/CSS/JS (timeline, panels, drag and drop).
- **Media engine:** native ffmpeg/ffprobe (bundled binaries) for probing, proxy generation, thumbnails, and export. libmpv or ffmpeg-based frame extraction for preview/scrubbing.
- **Target:** Windows .exe installer.

## Architecture
- The **project file is JSON** and is the heart of the app. Everything (UI, preview, export) reads from it.
- **Export** = translate the project JSON into an ffmpeg filter graph and run native ffmpeg.
- **Proxies:** on import, generate low-res proxy files + thumbnails in the background. Edit/preview against proxies, export from originals.

### Draft project schema
```json
{
  "version": 1,
  "settings": { "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000 },
  "media": [
    { "id": "m1", "path": "C:/clips/a.mp4", "proxyPath": "...", "duration": 12.5, "fps": 29.97, "hasAudio": true }
  ],
  "tracks": [
    {
      "id": "v1", "type": "video",
      "clips": [
        { "id": "c1", "mediaId": "m1", "start": 0.0, "in": 2.0, "out": 8.0, "volume": 1.0 }
      ]
    },
    {
      "id": "t1", "type": "text",
      "items": [
        { "id": "x1", "text": "Hello", "start": 1.0, "end": 4.0, "x": 0.5, "y": 0.9, "size": 48 }
      ]
    }
  ]
}
```
(`start` = position on timeline, `in`/`out` = trim points within the source, all in seconds.)

The implemented schema is now v3. It adds audio tracks (`type: "audio"`, clips with `volume`, `muted`, `fadeIn`/`fadeOut`); a video's own sound is an audio clip linked to it via `linkId`. It also adds audio-only media, `track.muted`, media `name`, `width`, `height`, `vfr` and cache paths, and text `color`. The full reference is [docs/project-schema.md](docs/project-schema.md).

## MVP scope (milestone 1)
1. Open/import clips (file picker + drag and drop); probe with ffprobe.
2. Background proxy + thumbnail generation.
3. Single video track timeline: arrange, trim, split, delete clips.
4. Playback with scrubbing.
5. Text overlays.
6. Per-clip audio volume.
7. Export to MP4 (H.264/AAC) via ffmpeg with progress bar.
8. Save/load project JSON.

## Later
Multiple video tracks, transitions, keyframed effects (position, scale, opacity), color adjustments, audio ducking/keyframed volume, hardware-accelerated export (NVENC/QSV/AMF), vertical/custom export presets.

Done beyond milestone 1: undo/redo; audio tracks with waveforms; linked clip sound with unlink; clip and track mute; fades (schema v3).

## Development practices
- **Build the export pipeline before the fancy UI.** A timeline that can't render correctly is just a drawing.
- Keep a `test-media/` folder of short clips with varied codecs, frame rates (24, 25, 29.97, 30, 60), resolutions, and at least one vertical phone video and one without audio.
- Write automated tests that export test projects and verify results with ffprobe: duration, resolution, fps, and audio/video sync.
- Keep the project schema documented and versioned; update this file when it changes.
- Known hard problems to respect: frame accuracy (variable frame rate phone footage!), audio sync, and responsive scrubbing.
