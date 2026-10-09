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

// Source monitor: click a media file to preview it without adding it to the timeline
const sourceState = () => page.evaluate(() => {
  const { store } = window.cutncrop;
  const v = document.querySelector('video');
  return {
    badge: !document.querySelector('.source-badge').hidden ? document.querySelector('.source-name').textContent : null,
    time: store.source ? +store.source.time.toFixed(2) : null,
    videoTime: +v.currentTime.toFixed(2),
    seeking: v.seeking,
    readyState: v.readyState,
    playhead: store.playhead,
    message: document.querySelector('.preview-message').hidden ? null : document.querySelector('.preview-message').textContent,
    videoVisible: v.style.visibility !== 'hidden',
    tc: document.querySelector('#timecode').textContent,
    clips: document.querySelectorAll('.clip').length,
  };
});
await page.click('.media-card:nth-child(2)'); // vertical_360x640.mp4
await page.waitForTimeout(300);
console.log('source opened', JSON.stringify(await sourceState()));
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
console.log('source after 1 s play', JSON.stringify(await sourceState()));
const bar = await page.locator('.source-bar').boundingBox();
await page.mouse.click(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
await page.waitForTimeout(300);
console.log('source scrubbed to 50%', JSON.stringify(await sourceState()));
await ss('03a-source');
await page.click('.media-card:nth-child(5)'); // tone.mp3
await page.keyboard.press('Space');
await page.waitForTimeout(700);
await page.keyboard.press('Space');
console.log('audio source', JSON.stringify(await sourceState()));
await page.keyboard.press('Escape');
console.log('after Esc', JSON.stringify(await sourceState()));

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

// Right-click menus
const menuLabels = () => page.evaluate(() => [...document.querySelectorAll('.context-menu .context-item')]
  .map((b) => `${b.querySelector('.context-label').textContent}${b.disabled ? ' (disabled)' : ''}`));
const clipCount = () => page.locator('.clip').count();
await page.click('.lane.video .clip:nth-child(3)', { button: 'right', position: { x: 30, y: 20 } });
console.log('video clip menu:', JSON.stringify(await menuLabels()));
await ss('04a-clip-menu');
await page.keyboard.press('Escape');
console.log('menu closed by Esc:', (await page.locator('.context-menu').count()) === 0);
const clipsBeforeDuplicate = await clipCount();
await page.click('.lane.video .clip:nth-child(3)', { button: 'right', position: { x: 30, y: 20 } });
await page.click('.context-item:has-text("Duplicate")');
console.log('duplicate: clips', clipsBeforeDuplicate, '->', await clipCount());
await page.keyboard.press('Control+z');
await page.click('.lane[data-track-id=a1] .clip:nth-child(2)', { button: 'right', position: { x: 30, y: 30 } });
console.log('sound clip menu:', JSON.stringify(await menuLabels()));
await page.click('.context-item:has-text("Fade in 1 s")');
console.log('fade in after menu:', await page.evaluate(() => {
  const { store } = window.cutncrop;
  const a1 = store.project.tracks.find((t) => t.id === 'a1');
  return [...a1.clips].sort((a, b) => a.start - b.start)[1].fadeIn;
}));
await page.keyboard.press('Control+z');
await page.click('.media-card:nth-child(5)', { button: 'right' });
console.log('media menu:', JSON.stringify(await menuLabels()));
await page.keyboard.press('Escape');

// Shortcut chart
await page.keyboard.press('F1');
console.log('shortcuts dialog open:', await page.evaluate(() => document.querySelector('#shortcuts-dialog').open),
  'groups:', await page.locator('.shortcut-group').count());
await ss('04b-shortcuts');
await page.keyboard.press('Escape');
console.log('shortcuts closed by Esc:', !(await page.evaluate(() => document.querySelector('#shortcuts-dialog').open)));

// Gaps: delete the middle-left clip (2..5) to leave a 3 s gap, then close it two ways.
const videoStarts = () => page.evaluate(() =>
  window.cutncrop.store.project.tracks.find((t) => t.id === 'v1').clips.map((c) => c.start).sort((a, b) => a - b));
await page.click('.lane.video .clip:nth-child(2)', { position: { x: 30, y: 20 } });
await page.keyboard.press('Delete');
console.log('gap made, video starts:', JSON.stringify(await videoStarts()));
await page.click('.lane.video .clip:nth-child(2)', { position: { x: 30, y: 20 } }); // now the clip after the gap
await page.keyboard.press('Control+ArrowLeft');
console.log('Ctrl+← on clip after gap:', JSON.stringify(await videoStarts()));
await page.keyboard.press('Control+z');
const zoomNow2 = await page.evaluate(() => window.cutncrop.store.zoom);
const laneBox = await page.locator('.lane.video').boundingBox();
await page.mouse.click(laneBox.x + 3.5 * zoomNow2, laneBox.y + 30, { button: 'right' }); // inside the gap
console.log('gap menu:', JSON.stringify(await menuLabels()));
await page.click('.context-item:has-text("Close gap")');
console.log('after Close gap:', JSON.stringify(await videoStarts()));
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z'); // restore the deleted clip
console.log('restored:', JSON.stringify(await videoStarts()));

// Effects: reverse the vertical clip (timeline 5..9, source 0..4) from its menu.
await page.click('.lane.video .clip:nth-child(3)', { button: 'right', position: { x: 30, y: 20 } });
console.log('effects in menu:', JSON.stringify(await page.evaluate(() => ({
  heading: document.querySelector('.context-heading')?.textContent,
  items: [...document.querySelectorAll('.context-item[role=menuitemcheckbox]')].map((b) => `${b.textContent} checked=${b.getAttribute('aria-checked')}`),
}))));
await page.click('.context-item:has-text("Reverse")');
const reverseState = () => page.evaluate(() => {
  const { store, preview } = window.cutncrop;
  const all = store.project.tracks.flatMap((t) => t.clips ?? []);
  const v = document.querySelector('video');
  return {
    reversed: all.filter((c) => c.effects?.some((e) => e.type === 'reverse')).map((c) => `${c.start}..${+(c.start + c.out - c.in).toFixed(2)}`),
    marks: document.querySelectorAll('.effect-mark').length,
    mode: preview.clipMode,
    src: v.currentSrc.includes('reverse-') ? 'reversed file' : 'source',
    videoTime: +v.currentTime.toFixed(3),
    note: document.querySelector('.preview-note').hidden ? null : document.querySelector('.preview-note').textContent,
  };
});
console.log('after Reverse:', JSON.stringify(await reverseState()));
await page.evaluate(() => window.cutncrop.store.setPlayhead(5.5)); // 0.5 s into the reversed clip
await page.waitForTimeout(400);
console.log('paused at 5.5 (expect source ≈ 3.483):', JSON.stringify(await reverseState()));
await ss('04c-reversed');
const fileReady = await page.waitForFunction(() => {
  const m = window.cutncrop.store.project.media.find((x) => x.name === 'vertical_360x640.mp4');
  return [...document.querySelectorAll('video')].length && m; // existence check only
}).then(() => page.evaluate(async () => {
  // Poll the preview until it can use the reversed file.
  const { store, preview } = window.cutncrop;
  for (let i = 0; i < 100; i++) {
    preview.play();
    await new Promise((r) => setTimeout(r, 100));
    const mode = preview.clipMode;
    preview.pause();
    store.setPlayhead(5);
    if (mode === 'reverse-file') return i * 0.1;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}));
console.log('reversed preview file ready after ~', fileReady, 's');
await page.evaluate(() => window.cutncrop.store.setPlayhead(5));
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
console.log('playing reversed clip for 1 s:', JSON.stringify({ ...(await reverseState()), playhead: await page.evaluate(() => +window.cutncrop.store.playhead.toFixed(2)) }));
await page.keyboard.press('Space');
await page.keyboard.press('Control+z'); // reverse off again for the rest of the run
console.log('after undo:', JSON.stringify((await reverseState()).reversed));

// Copy / paste. Video clips now start at 0, 2, 5, 9 (lengths 2, 3, 4, 4).
const zoomCP = await page.evaluate(() => window.cutncrop.store.zoom);
const videoLane = await page.locator('.lane.video').boundingBox();
const deselect = () => page.click('.lane.add-row', { position: { x: 5, y: 5 } });
await page.click('.lane.video .clip:nth-child(1)', { position: { x: 20, y: 20 } });
await page.keyboard.press('Control+c');
await deselect();
await page.keyboard.press('Control+v');
console.log('Ctrl+V, nothing selected (expect a copy at 13):', JSON.stringify(await videoStarts()));
await page.keyboard.press('Control+z');
await page.click('.lane.video .clip:nth-child(2)', { position: { x: 20, y: 20 } });
await page.keyboard.press('Control+v');
console.log('Ctrl+V after clip 2..5 (expect insert at 5):', JSON.stringify(await videoStarts()));
await page.keyboard.press('Control+z');
const rulerBox = await page.locator('.ruler').boundingBox();
await page.mouse.click(rulerBox.x + 3.5 * zoomCP, rulerBox.y + 5); // playhead 3.5, inside clip 2
await page.keyboard.press('Control+Shift+v');
console.log('Ctrl+Shift+V at 3.5 (expect split + insert):', JSON.stringify(await videoStarts()));
await page.keyboard.press('Control+z');
await page.keyboard.press('Home');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
console.log('Home, ↓, ↓ -> playhead', await page.evaluate(() => window.cutncrop.store.playhead));
await page.click('.lane.video .clip:nth-child(2)', { button: 'right', position: { x: 20, y: 20 } });
console.log('clip menu top:', JSON.stringify((await menuLabels()).slice(0, 3)));
await page.keyboard.press('Escape');

// Drag a media file onto the right half of clip 2..5: insertion line at 5, then insert.
// Playwright only fires HTML5 drag events on release, so the hover state is checked by
// dispatching the browser's own dragstart/dragover events like Windows does mid-drag.
const markerAt = (xSeconds) => page.evaluate(({ xSeconds }) => {
  const card = document.querySelector('.media-card:nth-child(3)');
  const dt = new DataTransfer();
  card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  const lane = document.querySelector('.lane.video');
  const box = lane.getBoundingClientRect();
  const x = box.left + xSeconds * window.cutncrop.store.zoom;
  const y = box.top + 30;
  document.elementFromPoint(x, y).dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const m = document.querySelector('.drop-marker');
  return { visible: !m.hidden, insert: m.classList.contains('insert'), at: +(parseFloat(m.style.transform.slice(11)) / window.cutncrop.store.zoom).toFixed(2) };
}, { xSeconds });
console.log('hover 4.3 s (right half of clip 2..5):', JSON.stringify(await markerAt(4.3)));
console.log('hover 2.4 s (left half of clip 2..5):', JSON.stringify(await markerAt(2.4)));
console.log('hover 13.3 s (empty, after the end):', JSON.stringify(await markerAt(13.3)));
await markerAt(4.3);
await ss('04d-drop-marker');
const card = await page.locator('.media-card:nth-child(3)').boundingBox(); // webm, 4 s
await page.mouse.move(card.x + 40, card.y + 20);
await page.mouse.down();
await page.mouse.move(videoLane.x + 4.3 * zoomCP, videoLane.y + 30, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log('after drop (expect insert at 5):', JSON.stringify(await videoStarts()));
await page.keyboard.press('Control+z');
console.log('restored:', JSON.stringify(await videoStarts()));

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
