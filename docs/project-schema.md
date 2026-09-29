# Project file schema (v3)

A project is saved as JSON with the `.cutncrop` extension. It is the single
source of truth: the UI, the preview and the exporter all read from it.
Code: `src/shared/schema.js` (creation, validation, migration).

```json
{
  "version": 3,
  "settings": { "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000 },
  "media": [
    {
      "id": "m…", "path": "C:/clips/a.mp4", "name": "a.mp4", "duration": 12.5,
      "hasVideo": true, "hasAudio": true, "audioChannels": 2,
      "fps": 29.97, "width": 1920, "height": 1080, "vfr": false,
      "proxyPath": "…/cache/…-proxy.mp4", "thumbPath": "…/cache/…-thumbs.jpg", "peaksPath": "…/cache/…-peaks.bin"
    },
    { "id": "m…", "path": "C:/music/song.mp3", "name": "song.mp3", "duration": 180.2,
      "hasVideo": false, "hasAudio": true, "audioChannels": 2, "fps": null, "width": 0, "height": 0 }
  ],
  "tracks": [
    { "id": "v1", "type": "video",
      "clips": [ { "id": "c1", "mediaId": "m1", "start": 0.0, "in": 2.0, "out": 8.0, "linkId": "l1" } ] },
    { "id": "a1", "type": "audio", "muted": false,
      "clips": [ { "id": "c2", "mediaId": "m1", "start": 0.0, "in": 2.0, "out": 8.0, "linkId": "l1",
                   "volume": 1.0, "muted": false, "fadeIn": 0, "fadeOut": 0 } ] },
    { "id": "a2", "type": "audio", "muted": false,
      "clips": [ { "id": "c3", "mediaId": "m2", "start": 0.0, "in": 0.0, "out": 30.0,
                   "volume": 0.8, "muted": false, "fadeIn": 1.0, "fadeOut": 2.0 } ] },
    { "id": "t1", "type": "text",
      "items": [ { "id": "x…", "text": "Hello", "start": 1.0, "end": 4.0,
                   "x": 0.5, "y": 0.9, "size": 64, "color": "#ffffff" } ] }
  ]
}
```

## Tracks

- **One video track** (`v1`): picture only.
- **One or more audio tracks** (`a1`, `a2`, …): all sound. When a video file with sound is added,
  its sound becomes an audio clip on the first audio track with room, **linked** to the video clip
  by a shared `linkId`. Linked clips always have identical `start`/`in`/`out` and are moved,
  trimmed, split and deleted together. Unlinking removes `linkId`, after which each can be edited
  alone. Audio clips can also come from audio files.
- All audio tracks are mixed at unity gain (adding tracks does not change levels).
- **One text track** (`t1`).
- `track.muted` (audio tracks) silences the whole track in preview and export.

## Fields

| Field | Meaning |
|---|---|
| `settings.width/height` | Output resolution in pixels. Must be even (H.264). |
| `settings.fps` | Output frame rate. NTSC rates are written as 29.97, 23.976, 59.94 and treated as exact 30000/1001 etc. |
| `settings.sampleRate` | Output audio rate (Hz). |
| `media[].hasVideo/hasAudio` | Which streams the file has. Audio-only files can only go on audio tracks. |
| `media[].audioChannels` | Source channel count. Mono is duplicated to both output channels at full level. |
| `media[].width/height` | Display size, after rotation metadata is applied (phone video). 0 for audio files. |
| `media[].vfr` | Source has a variable frame rate; it is conformed to `settings.fps` on export. |
| `media[].proxyPath/thumbPath/peaksPath` | Cache files (preview proxy, thumbnail strip, waveform peaks). May be null or stale; regenerated on open. Never used for export. |
| `clip.start` | Position on the timeline, seconds. |
| `clip.in/out` | Trim points within the source, seconds (`out` exclusive). Clip length = `out - in`. |
| `clip.linkId` | Optional. Clips sharing it are one linked unit (a video clip and its sound). |
| `clip.volume` | Audio clips: linear gain, 0–4 (1 = unchanged). The preview caps at 1. |
| `clip.muted` | Audio clips: silenced in preview and export. |
| `clip.fadeIn/fadeOut` | Audio clips: linear fade lengths in seconds; `fadeIn + fadeOut` ≤ clip length. |
| `text.start/end` | Timeline interval in seconds. |
| `text.x/y` | Center of the text as a fraction of the frame (0–1). |
| `text.size` | Font size in output pixels (relative to `settings.height`). |

## Rules

- All times are seconds, snapped to the project frame grid by the edit operations.
- Clips on the same track never overlap; gaps are allowed and render as black and/or silence.
- The timeline length is the end of the last video **or audio** clip. If audio runs past the
  last video clip, the video is extended with black. Text items do not extend the timeline.

## Versioning

Bump `SCHEMA_VERSION` for incompatible changes and add a step to
`migrateProject()`. Files from a newer version are refused rather than
misread. Update this document and `PROJECT_BRIEF.md` with every change.

- **v3**: a video clip's sound is a linked audio clip (`linkId`) instead of part of the video clip.
  Video clips lose `volume`/`audioMuted`, the video track loses `muted`, audio clips gain `muted`.
  On open, each v2 video clip with sound gets a linked audio clip (keeping its volume and mute).
- **v2**: audio tracks, audio-only media (`hasVideo`, `audioChannels`, `peaksPath`), `clip.audioMuted`,
  audio clip fades, `track.muted`. v1 files get an empty `a1` track and defaults on open.
- **v1**: first version (single video track + text track).
