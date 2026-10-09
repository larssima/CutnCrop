import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, migrateProject, SCHEMA_VERSION } from '../../src/shared/schema.js';
import { isReversed, sourceTimeAt } from '../../src/shared/effects.js';
import * as tl from '../../src/shared/timeline.js';
import { fpsRational, frameCount, samplesForFrames, snapToFrame, formatTimecode } from '../../src/shared/time.js';

function projectWithMedia(duration = 10, settings = {}) {
  const p = createProject(settings);
  p.media.push({ id: 'm1', path: 'a.mp4', duration, fps: 30, hasVideo: true, hasAudio: true });
  return p;
}

test('fps rationals', () => {
  assert.deepEqual(fpsRational(30), { num: 30, den: 1 });
  assert.deepEqual(fpsRational(29.97), { num: 30000, den: 1001 });
  assert.deepEqual(fpsRational(23.976), { num: 24000, den: 1001 });
  assert.deepEqual(fpsRational(59.94), { num: 60000, den: 1001 });
});

test('frame math', () => {
  assert.equal(frameCount(1, 29.97), 30);
  assert.equal(frameCount(10.01, 29.97), 300);
  assert.equal(snapToFrame(1.02, 30), 1.033333);
  // 30 frames at 30000/1001 = 1.001 s -> 48048 samples
  assert.equal(samplesForFrames(30, 29.97, 48000), 48048);
  assert.equal(formatTimecode(61.5, 30), '00:01:01:15');
});

test('addClip appends clips back to back', () => {
  const p = projectWithMedia(10);
  const a = tl.addClip(p, 'm1');
  const b = tl.addClip(p, 'm1');
  assert.equal(a.start, 0);
  assert.equal(b.start, 10);
  assert.equal(tl.projectDuration(p), 20);
  assert.deepEqual(validateProject(p), []);
});

test('split creates two contiguous clips covering the same source', () => {
  const p = projectWithMedia(10);
  const a = tl.addClip(p, 'm1');
  const b = tl.splitClip(p, a.id, 4);
  assert.equal(a.out, 4);
  assert.equal(b.start, 4);
  assert.equal(b.in, 4);
  assert.equal(b.out, 10);
  assert.equal(tl.projectDuration(p), 10);
  // Split at the very edge is refused
  assert.equal(tl.splitClip(p, a.id, 0), null);
});

test('trim in-edge keeps source anchored and out-edge clamps to media', () => {
  const p = projectWithMedia(10);
  const a = tl.addClip(p, 'm1', 2);
  tl.trimClip(p, a.id, 'in', 3);
  assert.equal(a.start, 3);
  assert.equal(a.in, 1);
  tl.trimClip(p, a.id, 'out', 50);
  assert.equal(a.out, 10);
  // Can't trim in-edge before source start
  tl.trimClip(p, a.id, 'in', 0);
  assert.equal(a.in, 0);
  assert.equal(a.start, 2);
});

test('moving a clip onto another pushes clips instead of overlapping', () => {
  const p = projectWithMedia(5);
  const a = tl.addClip(p, 'm1');
  const b = tl.addClip(p, 'm1');
  tl.moveClip(p, b.id, 1);
  assert.equal(a.start, 0);
  assert.equal(b.start, 5);
  tl.moveClip(p, b.id, 0);
  assert.equal(b.start, 0);
  assert.equal(a.start, 5);
  assert.deepEqual(validateProject(p), []);
});

test('ripple delete closes the hole', () => {
  const p = projectWithMedia(5);
  const a = tl.addClip(p, 'm1');
  const b = tl.addClip(p, 'm1');
  tl.deleteClip(p, a.id, { ripple: true });
  assert.equal(b.start, 0);
});

test('clipAt finds clips and gaps', () => {
  const p = projectWithMedia(5);
  const a = tl.addClip(p, 'm1', 2);
  assert.equal(tl.clipAt(p, 1), null);
  assert.equal(tl.clipAt(p, 2).id, a.id);
  assert.equal(tl.clipAt(p, 7), null);
});

test('text items are clamped and snapped', () => {
  const p = projectWithMedia(5);
  const x = tl.addText(p, { start: 1, end: 3, text: 'Hi' });
  tl.updateText(p, x.id, { start: 2.01, end: 1, x: 2 });
  assert.equal(x.start, 2);
  assert.ok(x.end > x.start);
  assert.equal(x.x, 1);
});

test('migrate v1 moves clip sound to a linked audio clip and rejects newer versions', () => {
  const p = migrateProject({
    version: 1,
    settings: { fps: 25 },
    media: [{ id: 'm1', path: 'a.mp4', duration: 5, fps: 25, hasAudio: true }],
    tracks: [{ id: 'v1', type: 'video', clips: [{ id: 'c1', mediaId: 'm1', start: 0, in: 0, out: 5, volume: 0.5 }] }],
  });
  assert.equal(p.version, SCHEMA_VERSION);
  assert.deepEqual(tl.findClip(p, 'c1').effects, []);
  assert.equal(p.settings.width, 1920);
  assert.ok(tl.textTrack(p));
  assert.equal(p.media[0].hasVideo, true);
  const video = tl.findClip(p, 'c1');
  const [audio] = tl.linkedPartners(p, video);
  assert.equal(tl.trackOfClip(p, audio.id).id, 'a1');
  assert.equal(audio.volume, 0.5);
  assert.equal('volume' in video, false);
  assert.deepEqual(validateProject(p), []);
  assert.throws(() => migrateProject({ version: 99 }));
});

test('migrate v2 keeps detached audio and mutes, and finds room for linked audio', () => {
  const p = migrateProject({
    version: 2,
    settings: {},
    media: [{ id: 'm1', path: 'a.mp4', duration: 5, hasVideo: true, hasAudio: true, audioChannels: 2 }],
    tracks: [
      { id: 'v1', type: 'video', muted: false, clips: [
        { id: 'c1', mediaId: 'm1', start: 0, in: 0, out: 5, volume: 1, audioMuted: true },
        { id: 'c2', mediaId: 'm1', start: 5, in: 0, out: 5, volume: 1, audioMuted: false },
      ] },
      // c1's audio was detached and moved later, overlapping where c2's audio will go.
      { id: 'a1', type: 'audio', muted: false, clips: [{ id: 'd1', mediaId: 'm1', start: 6, in: 0, out: 5, volume: 1, fadeIn: 0, fadeOut: 0 }] },
      { id: 't1', type: 'text', items: [] },
    ],
  });
  const [c1Audio] = tl.linkedPartners(p, tl.findClip(p, 'c1'));
  const [c2Audio] = tl.linkedPartners(p, tl.findClip(p, 'c2'));
  assert.equal(c1Audio.muted, true, 'muted clip sound stays muted');
  assert.equal(tl.trackOfClip(p, c1Audio.id).id, 'a1', '0..5 fits before the detached clip');
  assert.equal(tl.trackOfClip(p, c2Audio.id).id, 'a2', '5..10 collides with the detached clip at 6..11');
  assert.equal(tl.findClip(p, 'd1').linkId, undefined);
  assert.equal(c2Audio.start, 5);
  assert.deepEqual(validateProject(p), []);
});

function projectWithAudio() {
  const p = projectWithMedia(10);
  p.media.push({ id: 'song', path: 'song.mp3', duration: 20, hasVideo: false, hasAudio: true });
  p.media.push({ id: 'mute', path: 'mute.mp4', duration: 5, fps: 30, hasVideo: true, hasAudio: false });
  return p;
}

test('a video with sound gets a linked audio clip on A1; silent video does not', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1', 1);
  const [a] = tl.linkedPartners(p, v);
  assert.equal(tl.trackOfClip(p, a.id).id, 'a1');
  assert.deepEqual([a.start, a.in, a.out, a.volume, a.muted], [1, 0, 10, 1, false]);
  const silent = tl.addClip(p, 'mute');
  assert.equal(silent.linkId, undefined);
  assert.equal(tl.audioTracks(p)[0].clips.length, 1);
  assert.deepEqual(validateProject(p), []);
});

test('linked clips move, trim, split and delete together', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1');
  const [a] = tl.linkedPartners(p, v);

  tl.moveClip(p, a.id, 2); // dragging the audio moves the video too
  assert.deepEqual([v.start, a.start], [2, 2]);
  tl.trimClip(p, v.id, 'in', 3);
  assert.deepEqual([a.start, a.in], [3, 1]);
  tl.trimClip(p, a.id, 'out', 8);
  assert.equal(v.out, 6);

  const vRight = tl.splitClip(p, v.id, 5);
  const [aRight] = tl.linkedPartners(p, vRight);
  assert.deepEqual([aRight.start, aRight.in, aRight.out], [5, 3, 6]);
  assert.notEqual(vRight.linkId, v.linkId, 'each half has its own link');
  assert.deepEqual(validateProject(p), []);

  tl.deleteClip(p, vRight.id);
  assert.equal(tl.findClip(p, aRight.id), undefined, 'deleting a video clip deletes its linked sound');
  assert.equal(tl.projectDuration(p), 5);
});

test('deleting only the video (Ctrl+click selection) keeps its sound', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1');
  const next = tl.addClip(p, 'm1');
  const [a] = tl.linkedPartners(p, v);
  tl.deleteClip(p, v.id, { withLinked: false, ripple: true }); // ripple ignored: the sound still fills 0..10
  assert.equal(tl.findClip(p, v.id), undefined);
  assert.ok(tl.findClip(p, a.id), 'sound survives');
  assert.equal(a.linkId, undefined, 'sound is no longer linked');
  assert.equal(next.start, 10, 'nothing shifted');
  assert.deepEqual(validateProject(p), []);
});

test('deleting only the sound keeps the video and unlinks it', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1');
  const next = tl.addClip(p, 'm1');
  const [a] = tl.linkedPartners(p, v);
  tl.deleteClip(p, a.id, { ripple: true }); // ripple is ignored for audio
  assert.ok(tl.findClip(p, v.id), 'video survives');
  assert.equal(v.linkId, undefined, 'video is no longer linked');
  assert.equal(next.start, 10, 'nothing shifted');
  tl.moveClip(p, v.id, 30);
  assert.equal(tl.findClip(p, tl.linkedPartners(p, next)[0].id).start, 10, 'other clips unaffected');
  assert.deepEqual(validateProject(p), []);
});

test('unlink makes audio independent: delete or move it alone', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1');
  const [a] = tl.unlinkClip(p, v.id);
  tl.moveClip(p, a.id, 4);
  assert.deepEqual([v.start, a.start], [0, 4]);
  tl.deleteClip(p, a.id);
  assert.ok(tl.findClip(p, v.id));
  assert.deepEqual(validateProject(p), []);
});

test('mute and volume on a video clip act on its linked audio', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1');
  const [a] = tl.linkedPartners(p, v);
  tl.setClipVolume(p, v.id, 0.25);
  tl.setClipMuted(p, v.id, true);
  assert.deepEqual([a.volume, a.muted], [0.25, true]);
});

test('new clip sound goes to the first audio track with room', () => {
  const p = projectWithAudio();
  const song = tl.addClip(p, 'song', 12); // A1: 12..32
  tl.addClip(p, 'm1', 0); // V: 0..10, A1: 0..10
  const v2 = tl.addClip(p, 'm1', 5); // lands on the first clip -> pushed to 10; A1 is busy at 10..20
  const [a2] = tl.linkedPartners(p, v2);
  assert.deepEqual([v2.start, a2.start], [10, 10]);
  assert.equal(tl.trackOfClip(p, a2.id).id, 'a2');
  assert.equal(song.start, 12, 'music is left alone');
  assert.deepEqual(validateProject(p), []);
});

test('music dropped on a busy audio track goes to a track with room instead of pushing video', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1', 0); // V 0..10, A1 0..10
  const song = tl.addClip(p, 'song', 2, 'a1');
  assert.equal(tl.trackOfClip(p, song.id).id, 'a2');
  assert.deepEqual([v.start, song.start], [0, 2]);
});

test('moving a linked clip pushes whatever is in its partner\'s way', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1', 0); // V 0..10, A1 0..10
  const song = tl.addClip(p, 'song', 10); // A1 10..30
  tl.moveClip(p, v.id, 5); // A1 5..15 collides with the song
  assert.equal(song.start, 15);
  assert.deepEqual(validateProject(p), []);
});

test('duplicate puts a linked copy right after the clip and pushes later clips', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1'); // 0..10
  const next = tl.addClip(p, 'm1'); // 10..20
  tl.trimClip(p, v.id, 'in', 2); // v: 2..10, in 2
  const copy = tl.duplicateClip(p, v.id);
  const [copyAudio] = tl.linkedPartners(p, copy);
  assert.deepEqual([copy.start, copy.in, copy.out], [10, 2, 10]);
  assert.ok(copyAudio, 'the copy has its own linked sound');
  assert.notEqual(copy.linkId, v.linkId);
  assert.equal(copyAudio.start, 10);
  assert.equal(next.start, 18, 'later clip pushed by the copy length');
  assert.deepEqual(validateProject(p), []);

  const x = tl.addText(p, { start: 1, end: 3, text: 'Hi' });
  const xCopy = tl.duplicateText(p, x.id);
  assert.deepEqual([xCopy.start, xCopy.end, xCopy.text], [3, 5, 'Hi']);
});

test('move to end of previous clip / start of next clip', () => {
  const p = projectWithAudio();
  const a = tl.addClip(p, 'm1', 0); // 0..10
  const b = tl.addClip(p, 'm1', 14); // 14..24
  const c = tl.addClip(p, 'm1', 30); // 30..40
  const [bSound] = tl.linkedPartners(p, b);

  assert.equal(tl.previousEnd(p, b.id), 10);
  tl.moveToPreviousEnd(p, b.id);
  assert.deepEqual([b.start, bSound.start], [10, 10], 'video and its sound move together');

  assert.equal(tl.nextStart(p, b.id), 30);
  tl.moveToNextStart(p, b.id);
  assert.equal(b.start, 20, 'b now ends where c starts');

  tl.moveToPreviousEnd(p, a.id);
  assert.equal(a.start, 0, 'first clip goes to 0');
  assert.equal(tl.nextStart(p, c.id), null);
  assert.deepEqual(validateProject(p), []);

  const x = tl.addText(p, { start: 1, end: 3 });
  const y = tl.addText(p, { start: 6, end: 7 });
  tl.moveToPreviousEnd(p, y.id);
  assert.deepEqual([y.start, y.end], [3, 4]);
  assert.ok(x);
});

test('close gap pulls everything after it left, with linked sound', () => {
  const p = projectWithAudio();
  tl.addClip(p, 'm1', 0); // 0..10
  const b = tl.addClip(p, 'm1', 14); // 14..24
  const c = tl.addClip(p, 'm1', 30); // 30..40
  assert.deepEqual(tl.gapAt(p, 'v1', 12), { start: 10, end: 14 });
  assert.equal(tl.gapAt(p, 'v1', 5), null, 'on a clip');
  assert.equal(tl.gapAt(p, 'v1', 50), null, 'after the last clip');
  assert.equal(tl.closeGapAt(p, 'v1', 12), true);
  const [cSound] = tl.linkedPartners(p, c);
  assert.deepEqual([b.start, c.start, cSound.start], [10, 26, 26]);
  assert.deepEqual(validateProject(p), []);
});

test('reverse applies to a linked pair, maps time backwards and toggles off', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1', 0);
  tl.trimClip(p, v.id, 'in', 2); // start 2, source 2..10
  const [a] = tl.linkedPartners(p, v);
  assert.equal(tl.toggleEffect(p, a.id, 'reverse'), true);
  assert.ok(isReversed(v) && isReversed(a), 'reversing the sound reverses its video too');
  assert.equal(sourceTimeAt(v, 0), 10, 'first frame on the timeline is the source out point');
  assert.equal(sourceTimeAt(v, 8), 2);
  assert.deepEqual(validateProject(p), []);
  assert.equal(tl.toggleEffect(p, v.id, 'reverse'), false);
  assert.ok(!isReversed(v) && !isReversed(a));
  assert.throws(() => tl.toggleEffect(p, v.id, 'nope'));
});

test('splitting a reversed clip keeps the backwards order across both halves', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1', 0); // source 0..10
  tl.toggleEffect(p, v.id, 'reverse');
  const right = tl.splitClip(p, v.id, 3);
  // Left (timeline 0..3) shows source 10 -> 7; right (3..10) shows 7 -> 0.
  assert.deepEqual([v.in, v.out], [7, 10]);
  assert.deepEqual([right.start, right.in, right.out], [3, 0, 7]);
  assert.ok(isReversed(right));
  assert.notEqual(right.effects, v.effects, 'effects are copied, not shared');
  const [rightSound] = tl.linkedPartners(p, right);
  assert.deepEqual([rightSound.in, rightSound.out], [0, 7]);
  assert.deepEqual(validateProject(p), []);
});

test('trimming a reversed clip: left edge trims the source end, right edge the source start', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1', 0); // source 0..10
  tl.toggleEffect(p, v.id, 'reverse');
  tl.trimClip(p, v.id, 'in', 2); // drop the first 2 s of backwards playback = source 8..10
  assert.deepEqual([v.start, v.in, v.out], [2, 0, 8]);
  tl.trimClip(p, v.id, 'out', 7); // keep 5 s: source 3..8
  assert.deepEqual([v.start, v.in, v.out], [2, 3, 8]);
  tl.trimClip(p, v.id, 'in', 0); // extend left again: back up to source end 10
  assert.deepEqual([v.start, v.in, v.out], [0, 3, 10]);
  tl.trimClip(p, v.id, 'out', 50); // can't go before source start
  assert.deepEqual([v.in, v.out], [0, 10]);
  const [a] = tl.linkedPartners(p, v);
  assert.deepEqual([a.start, a.in, a.out], [v.start, v.in, v.out]);

  const copy = tl.duplicateClip(p, v.id);
  assert.ok(isReversed(copy));
  assert.notEqual(copy.effects, v.effects);
});

test('copy + paste at the end, after a clip (insert) and into another project', () => {
  const p = projectWithAudio();
  const a = tl.addClip(p, 'm1', 0); // 0..10
  const b = tl.addClip(p, 'm1', 10); // 10..20
  tl.trimClip(p, b.id, 'out', 15); // b: 10..15
  const song = tl.addClip(p, 'song', 15, tl.addAudioTrack(p).id); // A2: 15..35, after the cut
  tl.toggleEffect(p, a.id, 'reverse');
  const clip = tl.copyClip(p, a.id); // video + its sound
  assert.equal(clip.clips.length, 2);

  // At the end of the video track: nothing moves.
  const atEnd = tl.pasteClips(p, clip, tl.trackEnd(tl.videoTrack(p)));
  assert.equal(atEnd.start, 15);
  const [atEndSound] = tl.linkedPartners(p, atEnd);
  assert.ok(atEndSound, 'pasted video keeps a linked sound');
  assert.notEqual(atEnd.linkId, a.linkId, 'a new link, not the original');
  assert.ok(isReversed(atEnd) && isReversed(atEndSound), 'effects come along');
  assert.equal(song.start, 15, 'no insert: the song stays');

  // After clip a (insert): b, the clip at the end and the song all move right by 10.
  const between = tl.pasteClips(p, clip, tl.clipEnd(a), { insert: true });
  assert.equal(between.start, 10);
  assert.deepEqual([b.start, atEnd.start, song.start], [20, 25, 25]);
  assert.deepEqual(validateProject(p), []);

  // Into a fresh project: the media comes along.
  const other = createProject();
  const pasted = tl.pasteClips(other, clip, 0);
  assert.equal(other.media.length, 1);
  assert.equal(pasted.mediaId, other.media[0].id);
  assert.deepEqual(validateProject(other), []);
});

test('copying only the sound, text copy/paste, cut points', () => {
  const p = projectWithAudio();
  const v = tl.addClip(p, 'm1', 0);
  const [s] = tl.linkedPartners(p, v);
  const soundOnly = tl.copyClip(p, s.id);
  assert.equal(soundOnly.clips.length, 1, 'a sound clip is copied alone');
  const videoOnly = tl.copyClip(p, v.id, { withLinked: false });
  assert.equal(videoOnly.clips.length, 1);
  const pastedSound = tl.pasteClips(p, soundOnly, 12);
  assert.equal(tl.trackOfClip(p, pastedSound.id).type, 'audio');
  assert.equal(pastedSound.linkId, undefined);

  const x = tl.addText(p, { start: 1, end: 3, text: 'Hi' });
  const t2 = tl.pasteText(p, tl.copyText(p, x.id), 5);
  assert.deepEqual([t2.start, t2.end, t2.text], [5, 7, 'Hi']);

  assert.deepEqual(tl.cutPoints(p), [0, 10, 12, 22]);
});

test('images: default duration, stretch either edge, split, no reverse', () => {
  const p = projectWithAudio();
  p.media.push({ id: 'img', path: 'photo.jpg', isImage: true, duration: null, hasVideo: true, hasAudio: false, width: 4000, height: 3000 });
  p.settings.imageDuration = 4;
  const v = tl.addClip(p, 'm1', 0); // 0..10
  const img = tl.addClip(p, 'img'); // after the video
  assert.deepEqual([img.start, img.in, img.out], [10, 0, 4]);
  assert.equal(tl.linkedPartners(p, img).length, 0, 'images have no sound');
  assert.ok(tl.isImageClip(p, img));

  tl.trimClip(p, img.id, 'out', 100); // stretch far beyond any "source length"
  assert.equal(tl.clipDuration(img), 90);
  tl.setImageDuration(p, img.id, 7.5);
  assert.deepEqual([img.start, img.out], [10, 7.5]);
  tl.trimClip(p, v.id, 'out', 6); // make room on the left
  tl.trimClip(p, img.id, 'in', 8); // left edge from 10 to 8: 2 s longer, in stays 0
  assert.deepEqual([img.start, img.in, img.out], [8, 0, 9.5]);
  tl.trimClip(p, img.id, 'in', 0); // left edge stops at the end of the video (6)
  assert.deepEqual([img.start, img.in, img.out], [6, 0, 11.5]);
  assert.equal(v.start, 0, 'the video was not pushed aside');

  const right = tl.splitClip(p, img.id, img.start + 3);
  assert.deepEqual([img.out, right.in], [3, 0]);
  assert.throws(() => tl.toggleEffect(p, img.id, 'reverse'), /images/);
  assert.deepEqual(validateProject(p), []);
});

test('ripple delete shifts every track after the hole', () => {
  const p = projectWithAudio();
  const v1 = tl.addClip(p, 'm1');
  tl.addClip(p, 'm1');
  const song = tl.addClip(p, 'song', 25, tl.addAudioTrack(p).id);
  tl.deleteClip(p, v1.id, { ripple: true });
  assert.equal(song.start, 15);
  assert.deepEqual(validateProject(p), []);
});

test('audio-only media goes to the audio track and extends the project', () => {
  const p = projectWithAudio();
  const song = tl.addClip(p, 'song', 2);
  assert.ok(tl.audioTracks(p)[0].clips.includes(song));
  assert.equal(song.fadeIn, 0);
  assert.equal(tl.projectDuration(p), 22);
  assert.throws(() => tl.addClip(p, 'song', 0, 'v1'), /no video/);
  assert.throws(() => tl.addClip(p, 'mute', 0, 'a1'), /no audio/);
  assert.deepEqual(validateProject(p), []);
});

test('audio clips move between audio tracks and never overlap', () => {
  const p = projectWithAudio();
  const a2 = tl.addAudioTrack(p);
  const s1 = tl.addClip(p, 'song', 0);
  const s2 = tl.addClip(p, 'song', 0, a2.id);
  tl.moveClip(p, s2.id, 5, 'a1');
  assert.equal(tl.trackOfClip(p, s2.id).id, 'a1');
  assert.equal(s1.start, 0);
  assert.equal(s2.start, 20); // pushed after s1
  assert.equal(tl.removeAudioTrack(p, a2.id), true);
  assert.equal(tl.removeAudioTrack(p, 'a1'), false); // not empty, last audio track
});

test('fades are clamped and split between halves', () => {
  const p = projectWithAudio();
  const s = tl.addClip(p, 'song', 0);
  tl.setClipFades(p, s.id, { fadeIn: 2, fadeOut: 3 });
  const right = tl.splitClip(p, s.id, 10);
  assert.deepEqual([s.fadeIn, s.fadeOut], [2, 0]);
  assert.deepEqual([right.fadeIn, right.fadeOut], [0, 3]);
  tl.setClipFades(p, s.id, { fadeIn: 50 });
  assert.equal(s.fadeIn, 10);
  assert.equal(tl.fadeGain(right, 0), 1);
  assert.equal(tl.fadeGain(right, 10), 0);
  assert.equal(tl.fadeGain(right, 8.5), 0.5);
});
