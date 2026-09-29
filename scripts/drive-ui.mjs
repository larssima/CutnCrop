// End-to-end UI smoke run: launches the real Electron app with Playwright,
// imports test media, edits, plays, exports and saves, taking screenshots.
// Native file dialogs are stubbed in the main process.
//
//   node scripts/drive-ui.mjs [screenshotDir]

import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestMedia } from './make-test-media.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.resolve(process.argv[2] ?? path.join(root, 'test-output', 'ui'));
fs.mkdirSync(shots, { recursive: true });
const mediaDir = makeTestMedia({ quiet: true });
const exportPath = path.join(root, 'test-output', 'ui-export.mp4');
const projectPath = path.join(root, 'test-output', 'ui-project.cutncrop');
fs.rmSync(exportPath, { force: true });

const problems = [];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code terminals; makes Electron act as Node
// CUTNCROP_EXE=path/to/CutnCrop.exe drives a packaged build instead of the source tree.
// ffmpeg is then removed from PATH, so the run proves the bundled copy is used.
const packaged = process.env.CUTNCROP_EXE;
if (packaged) {
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path'); // "Path" on Windows
  env[pathKey] = env[pathKey].split(';').filter((d) => !/ffmpeg/i.test(d)).join(';');
  delete env.CUTNCROP_FFMPEG_DIR;
  console.log('driving packaged build', packaged);
}
const app = await electron.launch(packaged ? { executablePath: packaged, args: [], env } : { args: [root], cwd: root, env });
const page = await app.firstWindow();
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`console.${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
await page.waitForSelector('.media-list');
await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {});

const ss = async (name) => {
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  console.log('screenshot', name);
};
const stubDialogs = (open, save) =>
  app.evaluate(({ dialog }, { open, save }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: open });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: save });
  }, { open, save });

await ss('01-empty');
console.log('app:', await app.evaluate(({ app: electronApp }) => ({ version: electronApp.getVersion(), packaged: electronApp.isPackaged })));

// Import
const importFiles = ['cfr25_720p.mp4', 'vertical_360x640.mp4', 'webm_vp9_640.webm', 'noaudio_640.mp4', 'tone.mp3', 'beeps.wav'];
await stubDialogs(importFiles.map((f) => path.join(mediaDir, f)), exportPath);
await page.click('[data-command=import]');
await page.waitForFunction((n) => document.querySelectorAll('.media-card').length === n, importFiles.length);
await page.waitForFunction(() => !document.querySelector('.media-card .progress'), null, { timeout: 90_000 });
await ss('02-imported');

// Put three clips on the timeline, then fit
for (const i of [0, 1, 2]) await page.dblclick(`.media-card:nth-child(${i + 1})`);
await page.click('[data-command=zoomFit]');
await ss('03-timeline');

// Scrub to 2 s, split, add text
await page.evaluate(() => document.querySelector('.timeline-scroll').focus());
const box = await page.locator('.ruler').boundingBox();
const zoom = await page.evaluate(() => parseFloat(document.querySelector('.clip').style.width) / 5); // first clip is 5 s
await page.mouse.click(box.x + 2 * zoom, box.y + 5);
await page.keyboard.press('s');
await page.keyboard.press('t');
await page.waitForTimeout(500);
await ss('04-split-text');

// Audio: clip sound sits on A1, linked. Select only the first clip's sound and
// delete it (the video must stay), drop music in its place, drag a 1 s fade-in.
const linkedOnA1 = await page.evaluate(() => document.querySelectorAll('.lane[data-track-id=a1] .clip .link-mark').length);
console.log('linked clip sounds on A1:', linkedOnA1);
// Selection rules: click video = video + its sound; Ctrl+click = video only.
const counts = () => page.evaluate(() => ({
  video: document.querySelectorAll('.lane.video .clip').length,
  audio: document.querySelectorAll('.lane.audio .clip').length,
  selected: document.querySelectorAll('.clip.selected').length,
}));
const third = '.lane.video .clip:nth-child(3)';
await page.click(third, { position: { x: 30, y: 20 } });
const clickSel = await counts();
await page.keyboard.press('Delete');
console.log('click video: selected', clickSel.selected, '-> after Delete', JSON.stringify(await counts()));
await page.keyboard.press('Control+z');
await page.click(third, { position: { x: 30, y: 20 }, modifiers: ['Control'] });
const ctrlSel = await counts();
await page.keyboard.press('Delete');
console.log('ctrl+click video: selected', ctrlSel.selected, '-> after Delete', JSON.stringify(await counts()));
await page.keyboard.press('Control+z');
console.log('after undo', JSON.stringify(await counts()));

const videoClipsBefore = await page.locator('.lane.video .clip').count();
await page.click('.lane[data-track-id=a1] .clip:nth-child(1)', { position: { x: 30, y: 30 } });
await page.keyboard.press('Delete');
console.log('video clips before/after deleting a sound clip:', videoClipsBefore, await page.locator('.lane.video .clip').count());
await page.click('[data-command=zoomFit]');
// tone.mp3 at 0. Playwright's synthetic HTML5 drag occasionally doesn't register; retry once.
const tone = page.locator('.clip.audio', { hasText: 'tone.mp3' });
for (let attempt = 1; attempt <= 2 && !(await tone.count()); attempt++) {
  await page.dragAndDrop('.media-card:nth-child(5)', '.lane[data-track-id=a1]', { targetPosition: { x: 3, y: 25 } });
  await tone.first().waitFor({ timeout: 3000 }).catch(() => console.log(`drag attempt ${attempt} did not land`));
}
await tone.hover();
const fadeBox = await tone.locator('.fade-handle[data-fade=in]').boundingBox();
const zoomNow = await page.evaluate(() => window.cutncrop.store.zoom);
await page.mouse.move(fadeBox.x + 5, fadeBox.y + 5);
await page.mouse.down();
await page.mouse.move(fadeBox.x + 5 + zoomNow, fadeBox.y + 5, { steps: 5 });
await page.mouse.up();
const audioState = await page.evaluate(() => {
  const { store } = window.cutncrop;
  const name = (c) => store.project.media.find((m) => m.id === c.mediaId).name;
  const tracks = store.project.tracks.filter((t) => t.type !== 'text');
  return {
    tracks: Object.fromEntries(tracks.map((t) => [t.id, [...t.clips].sort((a, b) => a.start - b.start)
      .map((c) => `${name(c)}@${c.start}${c.linkId ? '🔗' : ''}${c.fadeIn ? ` fadeIn=${c.fadeIn}` : ''}`)])),
    waveforms: document.querySelectorAll('canvas.wave').length,
  };
});
console.log('audio state', JSON.stringify(audioState, null, 1));
await ss('05-audio');

// Play for 2 seconds, then check the video and the audio-track elements
await page.keyboard.press('Home');
await page.keyboard.press('Space');
await page.waitForTimeout(2000);
const playing = await page.evaluate(() => {
  const v = document.querySelector('video');
  const { store, preview } = window.cutncrop;
  const clips = store.project.tracks.filter((t) => t.type === 'audio').flatMap((t) => t.clips);
  const audio = [...preview.audio.entries].map(([id, { el }]) => {
    const c = clips.find((x) => x.id === id);
    const expected = c.in + (store.playhead - c.start);
    return { paused: el.paused, driftMs: Math.round((el.currentTime - expected) * 1000), err: el.error?.message ?? null };
  });
  return { tc: document.querySelector('#timecode').textContent, videoMuted: v.muted, t: +v.currentTime.toFixed(2), ready: v.readyState, err: v.error?.message ?? null, audio };
});
console.log('during playback', JSON.stringify(playing));
await ss('06-playing');
await page.keyboard.press('Space');

// Undo / redo round trip
const before = await page.evaluate(() => document.querySelectorAll('.clip').length);
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
const afterUndo = await page.evaluate(() => document.querySelectorAll('.clip').length);
await page.keyboard.press('Control+y');
await page.keyboard.press('Control+y');
const afterRedo = await page.evaluate(() => document.querySelectorAll('.clip').length);
console.log('clips before/undo/redo', before, afterUndo, afterRedo);

// Export
await page.click('[data-command=export]');
await page.selectOption('select[name=quality]', 'draft');
await page.click('.export-start');
await page.waitForFunction(() => ['done', 'error'].includes(document.querySelector('#export-dialog').dataset.state), null, { timeout: 120_000 });
console.log('export:', await page.textContent('.export-status'));
await ss('07-exported');
await page.click('.export-cancel');

// Save (menu accelerators like Ctrl+S are native and not reachable from Playwright; click the button)
await stubDialogs([], projectPath);
await page.click('[data-command=save]');
await page.waitForTimeout(500);
const saved = fs.existsSync(projectPath) && JSON.parse(fs.readFileSync(projectPath, 'utf8'));
console.log('saved project:', saved ? `${saved.media.length} media, ${saved.tracks[0].clips.length} clips` : 'MISSING');
console.log('window title:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()));

console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no console errors');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
await app.close().catch(() => {});
