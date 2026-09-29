// End-to-end export tests: build projects from test media, export with real
// ffmpeg and verify the result with ffprobe.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probe } from '../../src/main/ffmpeg/probe.js';
import { startExport } from '../../src/main/export/export.js';
import * as tl from '../../src/shared/timeline.js';
import { frameCount } from '../../src/shared/time.js';
import {
  hasFfmpeg, setup, mediaFrom, newProject, outFile, inspect, flashTimes, beepTimes, samplesDir,
} from './helpers.js';

const skip = !hasFfmpeg() && 'ffmpeg not available';
let media; // test-media dir

before(() => {
  if (!skip) media = setup();
});

const clipPath = (name) => path.join(media, name);

async function exportProject(project, name) {
  const out = outFile(name);
  const progress = [];
  await startExport(project, out, { quality: 'draft', onProgress: (p) => progress.push(p) }).promise;
  return { out, info: inspect(out), progress };
}

function assertAvMatch(info, expectedSeconds, fps) {
  const frameDur = 1 / fps;
  assert.equal(info.frames, frameCount(expectedSeconds, fps), 'video frame count');
  // AAC works in 1024-sample packets; allow one packet plus a frame of slack.
  assert.ok(
    Math.abs(info.audioDuration - info.videoDuration) <= frameDur + 1024 / 48000,
    `audio ${info.audioDuration}s vs video ${info.videoDuration}s`,
  );
}

test('probe reads fps, rotation, vfr and missing audio', { skip }, async () => {
  const ntsc = await probe(clipPath('ntsc2997_640.mp4'));
  assert.equal(ntsc.fps, 29.97);
  assert.equal(ntsc.hasAudio, true);

  const rotated = await probe(clipPath('rotated_phone.mp4'));
  assert.equal(rotated.width, 720);
  assert.equal(rotated.height, 1280);

  const noAudio = await probe(clipPath('noaudio_640.mp4'));
  assert.equal(noAudio.hasAudio, false);

  const vfr = await probe(clipPath('vfr_640.mp4'));
  assert.equal(vfr.vfr, true);
});

test('mixed formats, trims, gaps and text export with exact length and sync', { skip }, async () => {
  const p = newProject();
  const names = [
    'cfr24_1080p.mp4', 'ntsc2997_640.mp4', 'cfr60_640.mp4', 'vertical_360x640.mp4',
    'noaudio_640.mp4', 'vfr_640.mp4', 'webm_vp9_640.webm', 'rotated_phone.mp4',
  ];
  for (const n of names) {
    const m = tl.addMedia(p, await mediaFrom(clipPath(n)));
    const c = tl.addClip(p, m.id);
    tl.trimClip(p, c.id, 'out', c.start + 1.5); // 1.5 s of each
  }
  // Trim an in-point and leave a gap of 0.5 s.
  const second = tl.sortedClips(p)[1];
  tl.trimClip(p, second.id, 'in', second.start + 0.4);
  tl.moveClip(p, tl.sortedClips(p)[3].id, tl.sortedClips(p)[3].start + 0.5);
  tl.addText(p, { start: 0.5, end: 3, text: 'Hello: 100% \'quoted\' åäö' });

  const expected = tl.projectDuration(p);
  const { info, progress } = await exportProject(p, 'mixed.mp4');
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.fps, '30/1');
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.equal(info.channels, 2);
  assertAvMatch(info, expected, 30);
  assert.equal(progress.at(-1), 1);
});

test('29.97 fps project keeps exact frame count', { skip }, async () => {
  const p = newProject({ fps: 29.97 });
  const m = tl.addMedia(p, await mediaFrom(clipPath('cfr25_720p.mp4')));
  tl.addClip(p, m.id);
  const c2 = tl.addClip(p, m.id);
  tl.trimClip(p, c2.id, 'in', c2.start + 1.25);
  const expected = tl.projectDuration(p);
  const { info } = await exportProject(p, 'ntsc.mp4');
  assert.equal(info.fps, '30000/1001');
  assertAvMatch(info, expected, 30000 / 1001);
});

test('audio stays in sync with video across trims, splits and gaps', { skip }, async () => {
  const p = newProject({ width: 320, height: 240 });
  const m = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  const a = tl.addClip(p, m.id, 1.0);
  tl.trimClip(p, a.id, 'in', 1.5); // start 1.5, in 0.5 (1.5 s leading gap)
  tl.trimClip(p, a.id, 'out', 6.0); // source 0.5..5.0
  const b = tl.splitClip(p, a.id, 3.2); // b: source 2.2..5.0
  tl.moveClip(p, b.id, 4.0); // 0.8 s gap between the halves
  tl.setClipVolume(p, b.id, 0.5);

  const { out, info } = await exportProject(p, 'sync.mp4');
  const flashes = flashTimes(out);
  // silencedetect may report a silence end at EOF; ignore it.
  const beeps = beepTimes(out).filter((t) => t < info.videoDuration - 0.05);
  // Source flashes 1, 2 (clip a) -> 2.0, 3.0; source 3, 4 (clip b) -> 4.8, 5.8
  assert.deepEqual(flashes.map((t) => Math.round(t * 30)), [60, 90, 144, 174]);
  assert.equal(beeps.length, flashes.length, `beeps ${beeps} vs flashes ${flashes}`);
  flashes.forEach((f, i) => {
    assert.ok(Math.abs(f - beeps[i]) < 1 / 30 + 0.005, `flash ${f} vs beep ${beeps[i]}`);
  });
});

test('cancel stops ffmpeg and removes the partial file', { skip }, async () => {
  const p = newProject({ width: 1920, height: 1080 });
  const m = tl.addMedia(p, await mediaFrom(clipPath('cfr24_1080p.mp4')));
  for (let i = 0; i < 4; i++) tl.addClip(p, m.id);
  const out = outFile('cancelled.mp4');
  const job = startExport(p, out, { quality: 'high' });
  setTimeout(() => job.cancel(), 300);
  await assert.rejects(job.promise, (e) => e.cancelled === true);
  assert.equal(fs.existsSync(out), false);
});

test('empty timeline is rejected', { skip }, async () => {
  await assert.rejects(startExport(newProject(), outFile('empty.mp4')).promise, /empty/);
});

const hasSamples = fs.existsSync(samplesDir);
test('real-world containers from Samples/ (avi, wmv, mov, webm)', { skip: skip || (!hasSamples && 'no Samples/ folder') }, async () => {
  const p = newProject();
  const files = fs.readdirSync(samplesDir).filter((f) => /\.(avi|wmv|mov|webm)$/i.test(f));
  for (const f of files) {
    const m = tl.addMedia(p, await mediaFrom(path.join(samplesDir, f)));
    const c = tl.addClip(p, m.id);
    tl.trimClip(p, c.id, 'in', c.start + 10);
    tl.trimClip(p, c.id, 'out', c.start + 1);
  }
  const expected = tl.projectDuration(p);
  const { info } = await exportProject(p, 'samples.mp4');
  assertAvMatch(info, expected, 30);
});
