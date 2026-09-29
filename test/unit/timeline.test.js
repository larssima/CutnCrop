import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, migrateProject } from '../../src/shared/schema.js';
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
  assert.equal(p.version, 3);
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
