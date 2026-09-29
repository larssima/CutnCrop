// Timeline edit operations. Each operation mutates the project passed in; callers
// that need history (the UI store) pass a clone. All times are snapped to the
// project frame grid.
//
// Tracks: one video track, any number of audio tracks, one text track. Clips on
// a track never overlap. A video clip's own sound lives on an audio track as a
// separate clip *linked* to it (same linkId, same start/in/out): linked clips
// move, trim, split and delete together until they are unlinked.

import { newId, DEFAULT_TEXT_STYLE } from './schema.js';
import { snapToFrame, floorToFrame, frameDuration, round6 } from './time.js';

export const videoTrack = (project) => project.tracks.find((t) => t.type === 'video');
export const textTrack = (project) => project.tracks.find((t) => t.type === 'text');
export const audioTracks = (project) => project.tracks.filter((t) => t.type === 'audio');
/** Tracks that hold media clips (video + audio). */
export const clipTracks = (project) => project.tracks.filter((t) => t.type === 'video' || t.type === 'audio');

export const clipDuration = (clip) => round6(clip.out - clip.in);
export const clipEnd = (clip) => round6(clip.start + clip.out - clip.in);

export function findMedia(project, mediaId) {
  return project.media.find((m) => m.id === mediaId);
}

export function findTrack(project, trackId) {
  return project.tracks.find((t) => t.id === trackId);
}

/** Find a video or audio clip by id. */
export function findClip(project, clipId) {
  for (const t of clipTracks(project)) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return c;
  }
  return undefined;
}

export function trackOfClip(project, clipId) {
  return clipTracks(project).find((t) => t.clips.some((c) => c.id === clipId));
}

export function findText(project, itemId) {
  return textTrack(project).items.find((x) => x.id === itemId);
}

/** The clip plus every clip linked to it. */
export function linkGroup(project, clip) {
  if (!clip?.linkId) return clip ? [clip] : [];
  return clipTracks(project).flatMap((t) => t.clips.filter((c) => c.linkId === clip.linkId));
}

/** Clips linked to this one (not including itself). */
export function linkedPartners(project, clip) {
  return linkGroup(project, clip).filter((c) => c !== clip);
}

/** For a video clip: its linked audio clip(s). For an audio clip: itself. */
export function audioClipsOf(project, clip) {
  const track = trackOfClip(project, clip.id);
  if (track.type === 'audio') return [clip];
  return linkedPartners(project, clip).filter((c) => trackOfClip(project, c.id).type === 'audio');
}

/** A video clip's linked audio clip, or null. */
export function linkedAudioOf(project, videoClip) {
  return audioClipsOf(project, videoClip)[0] ?? null;
}

/** Is this audio clip linked to a video clip (so the video's own element can play it)? */
export function isLinkedToVideo(project, audioClip) {
  return linkedPartners(project, audioClip).some((c) => trackOfClip(project, c.id)?.type === 'video');
}

/** Clips of a track (default: the video track) sorted by timeline position. */
export function sortedClips(project, track = videoTrack(project)) {
  return [...track.clips].sort((a, b) => a.start - b.start);
}

/** Total timeline length: end of the last video or audio clip. Text doesn't extend it. */
export function projectDuration(project) {
  let max = 0;
  for (const t of clipTracks(project)) for (const c of t.clips) max = Math.max(max, clipEnd(c));
  return max;
}

/** The clip under time t (start <= t < end) on a track (default: video), or null in a gap. */
export function clipAt(project, t, track = videoTrack(project)) {
  return track.clips.find((c) => t >= c.start - 1e-9 && t < clipEnd(c) - 1e-9) ?? null;
}

export function textItemsAt(project, t) {
  return textTrack(project).items.filter((x) => t >= x.start && t < x.end);
}

/** Push overlapping clips on one track right. `priority` ids win start-time ties. */
function pushTrack(track, priority) {
  track.clips.sort((a, b) => a.start - b.start || (priority.has(a.id) ? -1 : priority.has(b.id) ? 1 : 0));
  let cursor = 0;
  for (const c of track.clips) {
    if (c.start < cursor) c.start = cursor;
    cursor = clipEnd(c);
  }
}

/**
 * Remove overlaps on every track by pushing clips right, keeping linked clips
 * aligned: when one member of a link group is pushed, the others follow, which
 * may push clips on their own tracks. Starts only ever grow, so this settles.
 */
export function resolveOverlaps(project, priorityIds = []) {
  const priority = new Set(priorityIds);
  for (let pass = 0; pass < 100; pass++) {
    for (const track of clipTracks(project)) pushTrack(track, priority);
    const groups = new Map();
    for (const t of clipTracks(project)) {
      for (const c of t.clips) if (c.linkId) groups.set(c.linkId, [...(groups.get(c.linkId) ?? []), c]);
    }
    let changed = false;
    for (const members of groups.values()) {
      const start = Math.max(...members.map((c) => c.start));
      for (const c of members) {
        if (c.start !== start) {
          c.start = start;
          changed = true;
        }
      }
    }
    if (!changed) return;
  }
}

/** Does [start, end) fit on the track without touching existing clips? */
export function fitsOnTrack(track, start, end, ignoreId = null) {
  return track.clips.every((c) => c.id === ignoreId || end <= c.start + 1e-6 || start >= clipEnd(c) - 1e-6);
}

export function addMedia(project, media) {
  project.media.push(media);
  return media;
}

/** Remove a media item and every clip that uses it. */
export function removeMedia(project, mediaId) {
  project.media = project.media.filter((m) => m.id !== mediaId);
  for (const t of clipTracks(project)) t.clips = t.clips.filter((c) => c.mediaId !== mediaId);
}

export function addAudioTrack(project) {
  const used = new Set(project.tracks.map((t) => t.id));
  let n = 1;
  while (used.has(`a${n}`)) n++;
  const track = { id: `a${n}`, type: 'audio', muted: false, clips: [] };
  // Keep audio tracks together, right after the last one.
  const lastAudio = project.tracks.findLastIndex((t) => t.type === 'audio' || t.type === 'video');
  project.tracks.splice(lastAudio + 1, 0, track);
  return track;
}

/** Remove an audio track (only if it is empty and not the last audio track). */
export function removeAudioTrack(project, trackId) {
  const track = findTrack(project, trackId);
  if (!track || track.type !== 'audio' || track.clips.length || audioTracks(project).length < 2) return false;
  project.tracks = project.tracks.filter((t) => t !== track);
  return true;
}

export function setTrackMuted(project, trackId, muted) {
  findTrack(project, trackId).muted = muted;
}

/** First audio track with room for [start, end), or a new one. */
export function audioTrackWithRoom(project, start, end) {
  return audioTracks(project).find((t) => fitsOnTrack(t, start, end)) ?? addAudioTrack(project);
}

function newAudioClip(fields) {
  return { volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...fields, id: newId('c') };
}

/**
 * Place a whole media item on the timeline.
 * - Video file, no track or the video track: a video clip, plus its sound as a
 *   linked audio clip on the first audio track with room.
 * - Audio file, or any file on an audio track: an audio clip only. If the track
 *   is busy at that time, the clip goes to the first audio track with room.
 * Default start: end of the target track. Returns the main (video or audio) clip.
 */
export function addClip(project, mediaId, start = null, trackId = null) {
  const media = findMedia(project, mediaId);
  if (!media) throw new Error(`Unknown media ${mediaId}`);
  let track = trackId ? findTrack(project, trackId) : null;
  if (!track) track = media.hasVideo ? videoTrack(project) : audioTracks(project)[0];
  if (track.type === 'video' && !media.hasVideo) throw new Error(`${media.name} has no video — put it on an audio track`);
  if (track.type === 'audio' && !media.hasAudio) throw new Error(`${media.name} has no audio`);

  const fps = project.settings.fps;
  const trackEnd = track.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  const timing = {
    mediaId,
    start: snapToFrame(start ?? trackEnd, fps),
    in: 0,
    out: floorToFrame(media.duration, fps) || frameDuration(fps),
  };

  if (track.type === 'audio') {
    const clip = newAudioClip(timing);
    // Don't shove existing clips (and, through links, their video) aside: if the
    // chosen track is busy there, use the first audio track with room.
    const end = timing.start + timing.out;
    if (!fitsOnTrack(track, timing.start, end) && trackId) track = audioTrackWithRoom(project, timing.start, end);
    track.clips.push(clip);
    resolveOverlaps(project, [clip.id]);
    return clip;
  }

  const clip = { ...timing, id: newId('c') };
  track.clips.push(clip);
  // Settle the video clip first, so its sound goes where there is room at its final position.
  resolveOverlaps(project, [clip.id]);
  if (media.hasAudio) {
    clip.linkId = newId('l');
    const audio = newAudioClip({ mediaId, start: clip.start, in: clip.in, out: clip.out, linkId: clip.linkId });
    audioTrackWithRoom(project, clip.start, clipEnd(clip)).clips.push(audio);
    resolveOverlaps(project, [clip.id, audio.id]);
  }
  return clip;
}

/**
 * Move a clip and everything linked to it. The dragged clip, if it is an audio
 * clip, may change to another audio track (targetTrackId).
 */
export function moveClip(project, clipId, newStart, targetTrackId = null) {
  const clip = findClip(project, clipId);
  const track = trackOfClip(project, clipId);
  const target = targetTrackId ? findTrack(project, targetTrackId) : null;
  if (target && target !== track && target.type === 'audio' && track.type === 'audio') {
    track.clips = track.clips.filter((c) => c !== clip);
    target.clips.push(clip);
  }
  const start = Math.max(0, snapToFrame(newStart, project.settings.fps));
  const group = linkGroup(project, clip);
  for (const c of group) c.start = start;
  resolveOverlaps(project, group.map((c) => c.id));
}

/**
 * Trim a clip edge (and its linked clips) to timeline time t. The 'in' edge
 * keeps the source content anchored (moves start and in together); the 'out'
 * edge changes only out.
 */
export function trimClip(project, clipId, edge, t) {
  const clip = findClip(project, clipId);
  const media = findMedia(project, clip.mediaId);
  const fps = project.settings.fps;
  const minDur = frameDuration(fps);
  t = snapToFrame(t, fps);

  if (edge === 'in') {
    let newIn = clip.in + (t - clip.start);
    newIn = Math.min(Math.max(newIn, 0), clip.out - minDur);
    // Can't start before timeline zero.
    newIn = Math.max(newIn, clip.in - clip.start);
    clip.start = round6(clip.start + (newIn - clip.in));
    clip.in = round6(newIn);
  } else {
    let newOut = clip.in + (t - clip.start);
    newOut = Math.max(newOut, clip.in + minDur);
    newOut = Math.min(newOut, floorToFrame(media.duration, fps) || media.duration);
    clip.out = round6(newOut);
  }
  const group = linkGroup(project, clip);
  for (const c of group) {
    Object.assign(c, { start: clip.start, in: clip.in, out: clip.out });
    clampFades(c);
  }
  resolveOverlaps(project, group.map((c) => c.id));
}

/** Split a clip (and its linked clips) at timeline time t. Returns the new right part of clipId, or null. */
export function splitClip(project, clipId, t) {
  const clip = findClip(project, clipId);
  const fps = project.settings.fps;
  t = snapToFrame(t, fps);
  const minDur = frameDuration(fps);
  if (t < clip.start + minDur - 1e-6 || t > clipEnd(clip) - minDur + 1e-6) return null;

  const group = linkGroup(project, clip);
  const newLink = clip.linkId ? newId('l') : undefined;
  let result = null;
  for (const c of group) {
    const splitSource = round6(c.in + (t - c.start));
    const right = { ...c, id: newId('c'), start: t, in: splitSource };
    if (newLink) right.linkId = newLink;
    c.out = splitSource;
    // The fade-in stays with the left part, the fade-out moves to the right part.
    if ('fadeIn' in c) {
      c.fadeOut = 0;
      right.fadeIn = 0;
      clampFades(c);
      clampFades(right);
    }
    trackOfClip(project, c.id).clips.push(right);
    if (c === clip) result = right;
  }
  resolveOverlaps(project);
  return result;
}

/**
 * Delete a clip, and with `withLinked` also its linked clips (default: yes for a
 * video clip, no for an audio clip). Clips left behind are unlinked.
 * Ripple (everything after shifts left, all tracks and text) only applies when
 * a video clip goes with all its linked clips; otherwise something still
 * occupies that time.
 */
export function deleteClip(project, clipId, { ripple = false, withLinked } = {}) {
  const clip = findClip(project, clipId);
  if (!clip) return;
  const isVideo = trackOfClip(project, clipId).type === 'video';
  withLinked ??= isVideo;
  const group = linkGroup(project, clip);
  const removed = new Set(withLinked ? group : [clip]);
  const survivors = group.filter((c) => !removed.has(c));
  for (const t of clipTracks(project)) t.clips = t.clips.filter((c) => !removed.has(c));
  // A link with a single member left is no link at all.
  if (survivors.length === 1) delete survivors[0].linkId;
  if (ripple && isVideo && survivors.length === 0) {
    const end = clipEnd(clip);
    const dur = clipDuration(clip);
    for (const t of clipTracks(project)) {
      for (const c of t.clips) if (c.start >= end - 1e-6) c.start = round6(c.start - dur);
    }
    for (const x of textTrack(project).items) {
      if (x.start >= end - 1e-6) {
        x.start = round6(x.start - dur);
        x.end = round6(x.end - dur);
      }
    }
    resolveOverlaps(project);
  }
}

/** Remove every gap on the video track so clips play back to back; linked audio follows. */
export function closeGaps(project) {
  let cursor = 0;
  const moved = [];
  for (const c of sortedClips(project)) {
    for (const m of linkGroup(project, c)) {
      m.start = cursor;
      moved.push(m.id);
    }
    cursor = clipEnd(c);
  }
  resolveOverlaps(project, moved);
}

/** Volume of an audio clip; for a video clip, of its linked audio. */
export function setClipVolume(project, clipId, volume) {
  for (const c of audioClipsOf(project, findClip(project, clipId))) c.volume = Math.max(0, Math.min(4, volume));
}

/** Mute an audio clip; for a video clip, its linked audio. */
export function setClipMuted(project, clipId, muted) {
  for (const c of audioClipsOf(project, findClip(project, clipId))) c.muted = muted;
}

/** Make a clip and its partners independent. Returns the former partners. */
export function unlinkClip(project, clipId) {
  const clip = findClip(project, clipId);
  const group = linkGroup(project, clip);
  for (const c of group) delete c.linkId;
  return group.filter((c) => c !== clip);
}

/** Fade lengths in seconds, kept within the clip. Audio clips only. */
export function setClipFades(project, clipId, { fadeIn, fadeOut }) {
  const clip = findClip(project, clipId);
  const fps = project.settings.fps;
  if (fadeIn !== undefined) clip.fadeIn = Math.max(0, snapToFrame(fadeIn, fps));
  if (fadeOut !== undefined) clip.fadeOut = Math.max(0, snapToFrame(fadeOut, fps));
  clampFades(clip, fadeOut !== undefined && fadeIn === undefined ? 'out' : 'in');
}

function clampFades(clip, keep = 'in') {
  if (!('fadeIn' in clip)) return;
  const dur = clipDuration(clip);
  if (keep === 'in') {
    clip.fadeIn = Math.min(clip.fadeIn, dur);
    clip.fadeOut = Math.min(clip.fadeOut, round6(dur - clip.fadeIn));
  } else {
    clip.fadeOut = Math.min(clip.fadeOut, dur);
    clip.fadeIn = Math.min(clip.fadeIn, round6(dur - clip.fadeOut));
  }
}

/** Gain (0..1) from an audio clip's fades at clip-relative time rel. */
export function fadeGain(clip, rel) {
  const dur = clipDuration(clip);
  let g = 1;
  if (clip.fadeIn > 0 && rel < clip.fadeIn) g = Math.min(g, rel / clip.fadeIn);
  if (clip.fadeOut > 0 && rel > dur - clip.fadeOut) g = Math.min(g, (dur - rel) / clip.fadeOut);
  return Math.max(0, Math.min(1, g));
}

export function addText(project, { start, end, text = 'Text', ...style }) {
  const fps = project.settings.fps;
  const item = {
    id: newId('x'),
    text,
    start: snapToFrame(start, fps),
    end: snapToFrame(end, fps),
    ...DEFAULT_TEXT_STYLE,
    size: Math.round(project.settings.height / 17),
    ...style,
  };
  if (item.end <= item.start) item.end = round6(item.start + frameDuration(fps));
  textTrack(project).items.push(item);
  return item;
}

/** Update text fields. Times are snapped; end is kept after start. */
export function updateText(project, itemId, changes) {
  const item = findText(project, itemId);
  const fps = project.settings.fps;
  Object.assign(item, changes);
  item.start = Math.max(0, snapToFrame(item.start, fps));
  item.end = snapToFrame(item.end, fps);
  if (item.end <= item.start) item.end = round6(item.start + frameDuration(fps));
  item.x = Math.min(1, Math.max(0, item.x));
  item.y = Math.min(1, Math.max(0, item.y));
}

export function deleteText(project, itemId) {
  const track = textTrack(project);
  track.items = track.items.filter((x) => x.id !== itemId);
}
