// Export tests for audio: linked clip sound, unlinked/moved/replaced audio,
// mixing levels, fades and muting. Verified from the exported file.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { probe } from '../../src/main/ffmpeg/probe.js';
import { startExport } from '../../src/main/export/export.js';
import * as tl from '../../src/shared/timeline.js';
import { frameCount } from '../../src/shared/time.js';
import {
  hasFfmpeg, setup, mediaFrom, newProject, outFile, inspect, flashTimes, beepTimes, volumeStats,
} from './helpers.js';

const skip = !hasFfmpeg() && 'ffmpeg not available';
let media;
before(() => {
  if (!skip) media = setup();
});
const clipPath = (name) => path.join(media, name);

async function exportProject(project, name) {
  const out = outFile(name);
  await startExport(project, out, { quality: 'draft' }).promise;
  return { out, info: inspect(out) };
}

/** Beeps, ignoring a silence end that silencedetect may report at EOF. */
function beeps(out, info) {
  return beepTimes(out).filter((t) => t < info.videoDuration - 0.05);
}

const ONE_FRAME = 1 / 30 + 0.005;

test('probe accepts audio-only files', { skip }, async () => {
  const wav = await probe(clipPath('beeps.wav'));
  assert.equal(wav.hasVideo, false);
  assert.equal(wav.hasAudio, true);
  assert.ok(Math.abs(wav.duration - 8) < 0.01);
  const mp3 = await probe(clipPath('tone.mp3'));
  assert.equal(mp3.hasVideo, false);
});

test('linked clip sound stays in sync with its video', { skip }, async () => {
  const p = newProject({ width: 320, height: 240 });
  const m = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  const v = tl.addClip(p, m.id, 1.0);
  tl.trimClip(p, v.id, 'in', 1.5); // start 1.5, in 0.5 (the linked audio follows)
  const { out, info } = await exportProject(p, 'audio-linked.mp4');
  const flashes = flashTimes(out);
  const found = beeps(out, info);
  assert.equal(flashes.length, 7);
  assert.equal(found.length, flashes.length, `beeps ${found} vs flashes ${flashes}`);
  flashes.forEach((f, i) => assert.ok(Math.abs(f - found[i]) < ONE_FRAME, `flash ${f} vs beep ${found[i]}`));
});

test('picture timing does not depend on MP4 edit lists (players that ignore them stay in sync)', { skip }, async () => {
  // With B-frames, the first frame used to be shifted by an edit list; players that
  // ignore edit lists then showed the picture ~67 ms late (sound ahead of the lips).
  const p = newProject({ width: 320, height: 240 });
  const m = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  tl.addClip(p, m.id, 0);
  const { out } = await exportProject(p, 'audio-editlist.mp4');
  const honored = flashTimes(out);
  const ignored = flashTimes(out, { ignoreEditList: true });
  assert.ok(honored.length >= 5);
  assert.deepEqual(ignored, honored);
});

test('unlinked audio moved by 0.5 s is offset by exactly 0.5 s', { skip }, async () => {
  const p = newProject({ width: 320, height: 240 });
  const m = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  const v = tl.addClip(p, m.id, 0);
  tl.trimClip(p, v.id, 'out', 5);
  const [a] = tl.unlinkClip(p, v.id);
  tl.moveClip(p, a.id, 0.5); // audio half a second late
  const { out, info } = await exportProject(p, 'audio-moved.mp4');
  const flashes = flashTimes(out);
  const found = beeps(out, info);
  assert.deepEqual(flashes.map((t) => Math.round(t * 30)), [0, 30, 60, 90, 120]);
  // The video ends at 5.0 but the audio runs to 5.5, so black is added.
  assert.equal(frameCount(info.videoDuration, 30), 165);
  flashes.forEach((f, i) => assert.ok(Math.abs(f + 0.5 - found[i]) < ONE_FRAME, `flash ${f} vs beep ${found[i]}`));
});

test('replacing a clip\'s sound with music extends the video to the music length', { skip }, async () => {
  const p = newProject({ width: 320, height: 240 });
  const video = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  const music = tl.addMedia(p, await mediaFrom(clipPath('beeps.wav')));
  const v = tl.addClip(p, video.id, 0);
  tl.trimClip(p, v.id, 'out', 4);
  const [own] = tl.unlinkClip(p, v.id);
  tl.deleteClip(p, own.id);
  assert.ok(tl.findClip(p, v.id), 'video survives deleting its unlinked sound');
  tl.addClip(p, music.id, 1.0); // beeps at 1, 2, ... 8
  const { out, info } = await exportProject(p, 'audio-replaced.mp4');
  assert.equal(info.frames, frameCount(9, 30), 'video extended with black to the end of the music');
  assert.ok(Math.abs(info.audioDuration - info.videoDuration) <= 1 / 30 + 1024 / 48000);
  const found = beeps(out, info);
  assert.deepEqual(found.map((t) => Math.round(t)), [1, 2, 3, 4, 5, 6, 7, 8]);
  found.forEach((t) => assert.ok(Math.abs(t - Math.round(t)) < ONE_FRAME, `beep at ${t}`));
});

test('mixing does not change levels (no amix normalization)', { skip }, async () => {
  const source = volumeStats(clipPath('tone.mp3'));
  const p = newProject({ width: 320, height: 240 });
  const video = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  const tone = tl.addMedia(p, await mediaFrom(clipPath('tone.mp3')));
  const v = tl.addClip(p, video.id, 0);
  tl.setClipMuted(p, v.id, true); // A1: muted clip sound
  const loud = tl.addClip(p, tone.id, 0, tl.addAudioTrack(p).id);
  const silent = tl.addClip(p, tone.id, 0, tl.addAudioTrack(p).id);
  tl.setClipVolume(p, silent.id, 0);
  assert.ok(loud);
  const { out } = await exportProject(p, 'audio-levels.mp4');
  const mixed = volumeStats(out, 1, 3);
  assert.ok(Math.abs(mixed.max - source.max) < 1, `mixed ${mixed.max} dB vs source ${source.max} dB`);
});

test('fades ramp the volume in and out', { skip }, async () => {
  const p = newProject({ width: 320, height: 240 });
  const tone = tl.addMedia(p, await mediaFrom(clipPath('tone.mp3')));
  const a = tl.addClip(p, tone.id, 0);
  tl.setClipFades(p, a.id, { fadeIn: 2, fadeOut: 2 });
  const { out } = await exportProject(p, 'audio-fades.mp4');
  const start = volumeStats(out, 0, 0.2).mean;
  const middle = volumeStats(out, 2.5, 1).mean;
  const end = volumeStats(out, 5.8, 0.2).mean;
  assert.ok(middle - start > 15, `start ${start} dB vs middle ${middle} dB`);
  assert.ok(middle - end > 15, `end ${end} dB vs middle ${middle} dB`);
});

test('muted tracks and muted clips are silent', { skip }, async () => {
  const p = newProject({ width: 320, height: 240 });
  const video = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  const tone = tl.addMedia(p, await mediaFrom(clipPath('tone.mp3')));
  const v = tl.addClip(p, video.id, 0); // clip sound on A1
  const a2 = tl.addAudioTrack(p);
  tl.addClip(p, tone.id, 0, a2.id);
  tl.setTrackMuted(p, a2.id, true);
  tl.setClipMuted(p, v.id, true);
  let { out } = await exportProject(p, 'audio-muted.mp4');
  assert.ok(volumeStats(out).max < -80, 'muted clip + muted track');

  tl.setClipMuted(p, v.id, false);
  tl.setTrackMuted(p, 'a1', true);
  ({ out } = await exportProject(p, 'audio-muted2.mp4'));
  assert.ok(volumeStats(out).max < -80, 'both tracks muted');

  tl.setTrackMuted(p, 'a1', false);
  ({ out } = await exportProject(p, 'audio-muted3.mp4'));
  assert.ok(volumeStats(out).max > -30, 'unmuted clip sound is audible');
});
