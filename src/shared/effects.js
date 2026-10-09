// Clip effects. A clip's `effects` is an ordered list of { type, ...params }.
// To add an effect: register it here, then implement it in the exporter
// (main/export/buildCommand.js) and, if it changes what is seen or heard, in
// the preview.

export const EFFECTS = {
  reverse: {
    label: 'Reverse',
    icon: '⟲',
    description: 'Play the clip from its end to its start',
    tracks: ['video', 'audio'],
    // Applied to a clip and its linked partners together, so picture and sound stay in sync.
    linked: true,
  },
};

export function hasEffect(clip, type) {
  return Boolean(clip?.effects?.some((e) => e.type === type));
}

export const isReversed = (clip) => hasEffect(clip, 'reverse');

/** Effects that can be used on a clip on a track of this type. */
export function effectsForTrack(trackType) {
  return Object.entries(EFFECTS)
    .filter(([, def]) => def.tracks.includes(trackType))
    .map(([type, def]) => ({ type, ...def }));
}

/**
 * Source time shown at clip-relative time `rel` (0 = clip start on the timeline).
 * Reversed clips run from `out` back to `in`.
 */
export function sourceTimeAt(clip, rel) {
  return isReversed(clip) ? clip.out - rel : clip.in + rel;
}

export function cloneEffects(effects) {
  return (effects ?? []).map((e) => ({ ...e }));
}
