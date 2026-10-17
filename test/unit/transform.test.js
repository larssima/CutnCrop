import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCrop, fillFrameCrop, cropLayout, hasCrop, MIN_VISIBLE } from '../../src/shared/transform.js';
import { createProject, validateProject, migrateProject, SCHEMA_VERSION } from '../../src/shared/schema.js';
import * as tl from '../../src/shared/timeline.js';

test('normalizeCrop clamps edges and keeps a visible area', () => {
  assert.deepEqual(normalizeCrop({ left: -1, right: 2 }), { left: 0, right: 0.95, top: 0, bottom: 0 });
  // Colliding edges: the dragged edge wins, otherwise both give way equally.
  assert.deepEqual(normalizeCrop({ left: 0.7, right: 0.5 }, 'left'), { left: 0.7, right: 0.25, top: 0, bottom: 0 });
  const even = normalizeCrop({ top: 0.6, bottom: 0.6 });
  assert.equal(+(1 - even.top - even.bottom).toFixed(4), MIN_VISIBLE);
  assert.equal(even.top, even.bottom);
});

test('fillFrameCrop trims a wide picture at the sides and a tall one at top/bottom', () => {
  // 3:2 photo into 16:9 frame: too tall -> trim top/bottom so 16:9 remains
  const tall = fillFrameCrop(1200, 800, 1920, 1080);
  assert.ok(tall.top > 0 && tall.top === tall.bottom && tall.left === 0);
  assert.ok(Math.abs((1200 / (800 * (1 - tall.top - tall.bottom))) - 16 / 9) < 0.01);
  // 16:9 video into a vertical 9:16 frame: trim the sides
  const wide = fillFrameCrop(1920, 1080, 1080, 1920);
  assert.ok(wide.left > 0 && wide.top === 0);
  assert.deepEqual(fillFrameCrop(1920, 1080, 1280, 720), { left: 0, right: 0, top: 0, bottom: 0 });
});

test('cropLayout places the cropped area like object-fit: contain', () => {
  // No crop: a 4:3 picture in a 16:9 box is centered with side bars.
  const plain = cropLayout(400, 300, {}, 1600, 900);
  assert.deepEqual([plain.left, plain.top, plain.width, plain.height], [200, 0, 1200, 900]);
  // Keep the right half: 200x300 visible, scaled x3 to 600x900, centered at x 500.
  const half = cropLayout(400, 300, { left: 0.5 }, 1600, 900);
  assert.equal(half.width, 1200);
  assert.equal(half.left + 0.5 * half.width, 500); // the visible area starts at 500
  assert.equal(half.inset, '0% 0% 0% 50%');
});

test('crop on clips: set, clamp, fill, reset, copied by split/duplicate, migrated', () => {
  const p = createProject({ width: 1920, height: 1080 });
  p.media.push({ id: 'm', path: 'a.mp4', duration: 10, fps: 30, hasVideo: true, hasAudio: true, width: 1440, height: 1080 });
  const v = tl.addClip(p, 'm');
  assert.equal(hasCrop(v), false);
  tl.setCrop(p, v.id, { left: 0.1 });
  assert.equal(v.transform.crop.left, 0.1);
  const right = tl.splitClip(p, v.id, 4);
  assert.notEqual(right.transform, v.transform, 'split halves get their own copy');
  tl.setCrop(p, right.id, { top: 0.2 });
  assert.equal(v.transform.crop.top, 0, 'editing one half leaves the other alone');
  const copy = tl.duplicateClip(p, v.id);
  assert.equal(copy.transform.crop.left, 0.1);
  tl.cropToFillFrame(p, v.id); // 4:3 into 16:9: trim top and bottom
  assert.ok(v.transform.crop.top > 0 && v.transform.crop.left === 0);
  tl.resetCrop(p, v.id);
  assert.equal(hasCrop(v), false);
  const [sound] = tl.linkedPartners(p, v);
  assert.throws(() => tl.setCrop(p, sound.id, { left: 0.1 }), /video and image/);
  assert.deepEqual(validateProject(p), []);

  const old = migrateProject({ version: 5, settings: {}, media: p.media, tracks: [{ id: 'v1', type: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 2, effects: [] }] }] });
  assert.equal(old.version, SCHEMA_VERSION);
  assert.deepEqual(old.tracks[0].clips[0].transform.crop, { left: 0, right: 0, top: 0, bottom: 0 });
});
