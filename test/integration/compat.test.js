// Backward compatibility: project files saved by released CutnCrop versions
// (built with that release's own code, see test/fixtures/projects/) must keep
// opening, validating and exporting. Add a fixture for every release that
// changes the project format.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateProject, validateProject, SCHEMA_VERSION } from '../../src/shared/schema.js';
import { startExport } from '../../src/main/export/export.js';
import * as tl from '../../src/shared/timeline.js';
import { hasFfmpeg, setup, outFile, inspect, volumeStats } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = path.join(root, 'test', 'fixtures', 'projects');
const skip = !hasFfmpeg() && 'ffmpeg not available';
before(() => {
  if (!skip) setup();
});

function open(name) {
  const project = migrateProject(JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8')));
  for (const m of project.media) m.path = path.join(root, m.path); // fixtures use repo-relative paths
  return project;
}

for (const name of fs.readdirSync(fixtures).filter((f) => f.endsWith('.cutncrop'))) {
  test(`opens and exports a project ${name.replace('.cutncrop', '').replace(/-/g, ' ')}`, { skip }, async () => {
    const p = open(name);
    assert.equal(p.version, SCHEMA_VERSION);
    assert.deepEqual(validateProject(p), []);
    const out = outFile(`compat-${name}.mp4`);
    await startExport(p, out, { quality: 'draft' }).promise;
    const info = inspect(out);
    assert.equal(info.frames, Math.round(tl.projectDuration(p) * p.settings.fps));
    assert.ok(volumeStats(out).max > -40, 'sound survives the upgrade');
  });
}

test('the 0.2.0 project keeps its mute, music volume, fade and unlinked clip', () => {
  const p = open('saved-by-v0.2.0.cutncrop');
  const [a1, a2] = tl.audioTracks(p);
  const sorted = (t) => [...t.clips].sort((x, y) => x.start - y.start);
  assert.equal(sorted(a1)[0].linkId, undefined, 'first clip stays unlinked');
  assert.equal(sorted(a1)[1].muted, true, 'second clip sound stays muted');
  assert.deepEqual([a2.clips[0].volume, a2.clips[0].fadeIn], [0.6, 1], 'music keeps volume and fade');
  assert.equal(tl.textTrack(p).items[0].text, 'Made in 0.2.0');
});
