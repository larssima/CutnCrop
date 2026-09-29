// Project schema (see docs/project-schema.md). The project JSON is the single
// source of truth: the UI, the preview and the exporter all read from it.

export const SCHEMA_VERSION = 3;

export const DEFAULT_SETTINGS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
});

export const DEFAULT_TEXT_STYLE = Object.freeze({
  x: 0.5,
  y: 0.9,
  size: 64,
  color: '#ffffff',
});

let idCounter = 0;

/** Short unique id with a type prefix (m = media, c = clip, x = text item). */
export function newId(prefix) {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createProject(settings = {}) {
  return {
    version: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    media: [],
    tracks: [
      { id: 'v1', type: 'video', clips: [] },
      { id: 'a1', type: 'audio', muted: false, clips: [] },
      { id: 't1', type: 'text', items: [] },
    ],
  };
}

/**
 * Build a media entry from ffprobe results (see main/ffmpeg/probe.js).
 * proxyPath / thumbPath / peaksPath are filled in later by background jobs.
 */
export function createMedia(info) {
  return {
    id: newId('m'),
    path: info.path,
    name: info.name,
    duration: info.duration,
    hasVideo: info.hasVideo !== false,
    hasAudio: info.hasAudio,
    audioChannels: info.audioChannels ?? (info.hasAudio ? 2 : 0),
    fps: info.fps ?? null,
    width: info.width ?? 0,
    height: info.height ?? 0,
    vfr: Boolean(info.vfr),
    proxyPath: null,
    thumbPath: null,
    peaksPath: null,
  };
}

/** Upgrade older project files to the current schema version. */
export function migrateProject(project) {
  if (!project || typeof project !== 'object') throw new Error('Not a project file');
  if (project.version > SCHEMA_VERSION) {
    throw new Error(`Project was saved by a newer CutnCrop (schema v${project.version})`);
  }
  const p = structuredClone(project);
  p.settings = { ...DEFAULT_SETTINGS, ...p.settings };
  p.media ??= [];
  p.tracks ??= [];

  // v1 -> v2: audio tracks, audio-only media, fades, track mute.
  for (const m of p.media) {
    m.hasVideo ??= true;
    m.audioChannels ??= m.hasAudio ? 2 : 0;
    m.peaksPath ??= null;
  }
  if (!p.tracks.some((t) => t.type === 'video')) p.tracks.unshift({ id: 'v1', type: 'video', clips: [] });
  if (!p.tracks.some((t) => t.type === 'audio')) {
    const textIndex = p.tracks.findIndex((t) => t.type === 'text');
    p.tracks.splice(textIndex < 0 ? p.tracks.length : textIndex, 0, { id: 'a1', type: 'audio', clips: [] });
  }
  if (!p.tracks.some((t) => t.type === 'text')) p.tracks.push({ id: 't1', type: 'text', items: [] });

  for (const track of p.tracks) {
    if (track.type === 'text') {
      for (const item of track.items) for (const [k, v] of Object.entries(DEFAULT_TEXT_STYLE)) item[k] ??= v;
      continue;
    }
    if (track.type === 'audio') {
      track.muted ??= false;
      for (const clip of track.clips) {
        clip.volume ??= 1;
        clip.muted ??= false;
        clip.fadeIn ??= 0;
        clip.fadeOut ??= 0;
      }
    }
  }
  if ((project.version ?? 1) < 3) migrateLinkedAudio(p);
  p.version = SCHEMA_VERSION;
  return p;
}

/**
 * v2 -> v3: a video clip's sound was part of the video clip (volume, audioMuted,
 * video track mute). It becomes a linked audio clip on an audio track.
 */
function migrateLinkedAudio(p) {
  const video = p.tracks.find((t) => t.type === 'video');
  const audio = p.tracks.filter((t) => t.type === 'audio');
  const media = new Map(p.media.map((m) => [m.id, m]));
  const end = (c) => c.start + c.out - c.in;
  const fits = (track, clip) => track.clips.every((c) => end(clip) <= c.start + 1e-6 || clip.start >= end(c) - 1e-6);

  for (const clip of [...video.clips].sort((a, b) => a.start - b.start)) {
    const { volume = 1, audioMuted = false } = clip;
    delete clip.volume;
    delete clip.audioMuted;
    if (!media.get(clip.mediaId)?.hasAudio) continue;
    let track = audio.find((t) => fits(t, clip));
    if (!track) {
      const used = new Set(p.tracks.map((t) => t.id));
      let n = 1;
      while (used.has(`a${n}`)) n++;
      track = { id: `a${n}`, type: 'audio', muted: false, clips: [] };
      p.tracks.splice(p.tracks.indexOf(audio.at(-1)) + 1, 0, track);
      audio.push(track);
    }
    clip.linkId = newId('l');
    track.clips.push({
      id: newId('c'), mediaId: clip.mediaId, start: clip.start, in: clip.in, out: clip.out,
      volume, muted: audioMuted || Boolean(video.muted), fadeIn: 0, fadeOut: 0, linkId: clip.linkId,
    });
  }
  delete video.muted;
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateProject(project) {
  const errors = [];
  const { settings } = project;
  if (!(settings.width > 0 && settings.height > 0)) errors.push('Invalid resolution');
  if (settings.width % 2 || settings.height % 2) errors.push('Resolution must be even (H.264 requirement)');
  if (!(settings.fps > 0)) errors.push('Invalid frame rate');

  const media = new Map(project.media.map((m) => [m.id, m]));
  const links = new Map();
  for (const track of project.tracks) {
    if (track.type === 'text') {
      for (const item of track.items) {
        if (!(item.end > item.start)) errors.push(`Text ${item.id} has end <= start`);
      }
      continue;
    }
    for (const c of track.clips) {
      const m = media.get(c.mediaId);
      if (!m) errors.push(`Clip ${c.id} references missing media ${c.mediaId}`);
      else if (track.type === 'video' && !m.hasVideo) errors.push(`Clip ${c.id}: ${m.name} has no video`);
      else if (track.type === 'audio' && !m.hasAudio) errors.push(`Clip ${c.id}: ${m.name} has no audio`);
      if (!(c.out > c.in)) errors.push(`Clip ${c.id} has out <= in`);
      if (c.in < 0 || c.start < 0) errors.push(`Clip ${c.id} has a negative time`);
      if (track.type === 'audio') {
        if (!(c.volume >= 0)) errors.push(`Clip ${c.id} has invalid volume`);
        if (c.fadeIn < 0 || c.fadeOut < 0 || c.fadeIn + c.fadeOut > c.out - c.in + 1e-6) {
          errors.push(`Clip ${c.id} has invalid fades`);
        }
      }
      if (c.linkId) {
        const group = links.get(c.linkId) ?? [];
        links.set(c.linkId, [...group, c]);
      }
    }
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      if (sorted[i].start < prev.start + (prev.out - prev.in) - 1e-6) {
        errors.push(`Clips ${prev.id} and ${sorted[i].id} overlap on track ${track.id}`);
      }
    }
  }
  for (const [linkId, group] of links) {
    const [a, ...rest] = group;
    if (rest.some((c) => Math.abs(c.start - a.start) > 1e-6 || Math.abs(c.in - a.in) > 1e-6 || Math.abs(c.out - a.out) > 1e-6)) {
      errors.push(`Linked clips ${linkId} are out of sync`);
    }
  }
  return errors;
}
