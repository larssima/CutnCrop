import { app, BrowserWindow, ipcMain, dialog, protocol, Menu, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from './ffmpeg/probe.js';
import { ffmpegPaths } from './ffmpeg/paths.js';
import { MediaPreparer } from './media/proxy.js';
import { startExport } from './export/export.js';
import { migrateProject } from '../shared/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', 'mpg', 'mpeg', 'flv', '3gp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aif', 'aiff'];
const PROJECT_EXTENSION = 'cutncrop';

let win = null;
let dirty = false;
let exportJob = null;
let preparer = null;

// Only files the app has probed or produced may be served to the renderer.
const servable = new Set();
const allow = (p) => p && servable.add(path.resolve(p).toLowerCase());

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.jpg': 'image/jpeg', '.png': 'image/png',
};

/** media://file/<encoded absolute path>, with HTTP Range support for video seeking. */
async function serveMedia(request) {
  const url = new URL(request.url);
  const filePath = decodeURIComponent(url.pathname.slice(1));
  if (!servable.has(path.resolve(filePath).toLowerCase())) return new Response('Forbidden', { status: 403 });

  let size;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  // The page is file:// (origin "null"); allow its fetch() calls, e.g. for waveform peaks.
  const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
  if (!range) {
    const body = Readable.toWeb(fs.createReadStream(filePath));
    return new Response(body, { headers: { ...common, 'Content-Length': String(size) } });
  }
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const body = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
  return new Response(body, {
    status: 206,
    headers: {
      ...common,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    },
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#16171b',
    title: 'CutnCrop',
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(here, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Quit anyway? Unsaved edits will be lost.',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => {
    exportJob?.cancel();
    win = null;
  });
}

/** First line of `ffmpeg -version`, e.g. "ffmpeg version 2026-09-10-git-… Copyright …". */
function ffmpegVersion() {
  const r = spawnSync(ffmpegPaths().ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].replace(/ Copyright.*$/, '') : 'not found';
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'About CutnCrop',
    message: `CutnCrop ${app.getVersion()}`,
    detail: [
      'A desktop video editor.',
      '',
      `FFmpeg: ${ffmpegVersion()}`,
      `FFmpeg location: ${ffmpegPaths().ffmpeg}`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      '',
      'Free software under the GNU GPL v3.0 or later.',
      'https://github.com/larssima/CutnCrop',
    ].join('\n'),
    buttons: ['OK'],
  });
}

function buildMenu() {
  const cmd = (name) => () => send('menu:command', name);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: cmd('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('saveAs') },
        { type: 'separator' },
        { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: cmd('import') },
        { label: 'Export Video…', accelerator: 'CmdOrCtrl+E', click: cmd('export') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo are handled by the renderer's keyboard handler so they work
        // for both the timeline and text fields; listed here for discoverability.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: cmd('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: cmd('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About CutnCrop', click: () => showAbout() },
        { label: 'Project page', click: () => shell.openExternal('https://github.com/larssima/CutnCrop') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('media:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video and audio', extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('media:probe', async (_e, paths) =>
    Promise.all(
      paths.map(async (p) => {
        try {
          const info = await probe(p);
          allow(p);
          return { ok: true, info };
        } catch (e) {
          return { ok: false, path: p, error: e.message };
        }
      }),
    ),
  );

  ipcMain.handle('media:prepare', (_e, mediaList) => {
    for (const m of mediaList) {
      allow(m.path);
      preparer.add(m);
    }
  });

  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'CutnCrop project', extensions: [PROJECT_EXTENSION, 'json'] }],
    });
    if (r.canceled) return null;
    const filePath = r.filePaths[0];
    const project = migrateProject(JSON.parse(await fsp.readFile(filePath, 'utf8')));
    const missing = [];
    for (const m of project.media) {
      if (fs.existsSync(m.path)) allow(m.path);
      else missing.push(m.path);
      // Proxies and thumbnails are cache; they are re-created if gone.
      m.proxyPath = null;
      m.thumbPath = null;
      m.peaksPath = null;
    }
    return { project, filePath, missing };
  });

  ipcMain.handle('project:save', async (_e, { project, filePath, saveAs }) => {
    let target = filePath;
    if (!target || saveAs) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Save project',
        defaultPath: target ?? `Untitled.${PROJECT_EXTENSION}`,
        filters: [{ name: 'CutnCrop project', extensions: [PROJECT_EXTENSION] }],
      });
      if (r.canceled) return null;
      target = r.filePath;
    }
    await fsp.writeFile(target, JSON.stringify(project, null, 2), 'utf8');
    return target;
  });

  ipcMain.handle('export:pick', async (_e, defaultName) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Export video',
      defaultPath: path.join(app.getPath('videos'), defaultName),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('export:start', async (_e, { project, outPath, quality }) => {
    if (exportJob) throw new Error('An export is already running');
    exportJob = startExport(project, outPath, { quality, onProgress: (p) => send('export:progress', p) });
    try {
      return await exportJob.promise;
    } catch (e) {
      if (e.cancelled) return { cancelled: true };
      throw e;
    } finally {
      exportJob = null;
    }
  });

  ipcMain.handle('export:cancel', () => exportJob?.cancel());
  ipcMain.on('app:version', (e) => (e.returnValue = app.getVersion()));
  ipcMain.on('app:dirty', (_e, value) => (dirty = Boolean(value)));
  ipcMain.on('app:title', (_e, title) => win?.setTitle(title));
  ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
}

app.whenReady().then(() => {
  protocol.handle('media', serveMedia);
  preparer = new MediaPreparer(path.join(app.getPath('userData'), 'cache'), (id, patch) => {
    allow(patch.thumbPath);
    allow(patch.peaksPath);
    allow(patch.proxyPath);
    send('media:update', { id, ...patch });
  });
  registerIpc();
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
