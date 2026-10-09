// Still images on the timeline: probing, exact durations, scaling and transparency.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { probe } from '../../src/main/ffmpeg/probe.js';
import { startExport } from '../../src/main/export/export.js';
import * as tl from '../../src/shared/timeline.js';
import { hasFfmpeg, setup, mediaFrom, newProject, outFile, inspect, lumaAt } from './helpers.js';

const skip = !hasFfmpeg() && 'ffmpeg not available';
let media;
before(() => {
  if (!skip) media = setup();
});
const clipPath = (name) => path.join(media, name);

test('probe recognizes still images (and keeps animated video as video)', { skip }, async () => {
  const jpg = await probe(clipPath('photo_1200x800.jpg'));
  assert.equal(jpg.isImage, true);
  assert.deepEqual([jpg.width, jpg.height, jpg.hasAudio, jpg.duration], [1200, 800, false, null]);
  const png = await probe(clipPath('half_transparent_400.png'));
  assert.equal(png.isImage, true);
  const video = await probe(clipPath('sync_30.mp4'));
  assert.equal(video.isImage, undefined);
});

test('images export for exactly their clip length, scaled to fit, transparency as black', { skip }, async () => {
  const p = newProject({ width: 320, height: 240, fps: 30 });
  const white = tl.addMedia(p, await mediaFrom(clipPath('white_400.png')));
  const video = tl.addMedia(p, await mediaFrom(clipPath('sync_30.mp4')));
  const half = tl.addMedia(p, await mediaFrom(clipPath('half_transparent_400.png')));
  const photo = tl.addMedia(p, await mediaFrom(clipPath('photo_1200x800.jpg')));

  const w = tl.addClip(p, white.id); // default 5 s
  tl.setImageDuration(p, w.id, 2.5);
  const v = tl.addClip(p, video.id);
  tl.trimClip(p, v.id, 'out', v.start + 1);
  const h = tl.addClip(p, half.id);
  tl.setImageDuration(p, h.id, 1);
  const ph = tl.addClip(p, photo.id);
  tl.setImageDuration(p, ph.id, 0.5);

  const out = outFile('images.mp4');
  await startExport(p, out, { quality: 'draft' }).promise;
  const info = inspect(out);
  assert.equal(info.frames, 75 + 30 + 30 + 15, 'frame-exact lengths');
  assert.ok(Math.abs(info.audioDuration - info.videoDuration) <= 1 / 30 + 1024 / 48000, 'silent audio spans the images');

  // The square image fills the frame height: 240x240 at x = 40..280, black bars at the sides.
  assert.ok(lumaAt(out, 1.0, { w: 80, h: 80, x: 120, y: 80 }) > 230, 'white image is white');
  assert.ok(lumaAt(out, 1.0, { w: 30, h: 80, x: 0, y: 80 }) < 20, 'letterbox bars are black');
  // Half-transparent PNG at 3.5..4.5: transparent left half -> black, right half -> white.
  assert.ok(lumaAt(out, 4.0, { w: 80, h: 80, x: 60, y: 80 }) < 20, 'transparent half is black');
  assert.ok(lumaAt(out, 4.0, { w: 80, h: 80, x: 180, y: 80 }) > 230, 'opaque half is white');
});
