// Copy ffmpeg/ffprobe into vendor/ffmpeg so the installer bundles them, along
// with FFmpeg's license and a note on where its source is (GPL obligations).
// Source: CUTNCROP_FFMPEG_DIR (folder with the executables), or those on PATH.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'ffmpeg');
const exe = process.platform === 'win32' ? '.exe' : '';

function locate(name) {
  if (process.env.CUTNCROP_FFMPEG_DIR) return path.join(process.env.CUTNCROP_FFMPEG_DIR, name + exe);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return execFileSync(finder, [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
}

fs.mkdirSync(dest, { recursive: true });
let binDir = null;
for (const name of ['ffmpeg', 'ffprobe']) {
  const src = locate(name);
  const target = path.join(dest, name + exe);
  const same = fs.existsSync(target) && fs.statSync(target).size === fs.statSync(src).size
    && fs.statSync(target).mtimeMs >= fs.statSync(src).mtimeMs;
  if (!same) fs.copyFileSync(src, target);
  console.log(`${name}: ${src} -> ${target}${same ? ' (up to date)' : ''}`);
  binDir = path.dirname(src);
}

// Builds usually keep LICENSE/README next to bin/ (gyan.dev, BtbN).
for (const file of ['LICENSE', 'LICENSE.txt', 'README.txt']) {
  for (const dir of [binDir, path.dirname(binDir)]) {
    const src = path.join(dir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dest, `FFMPEG-${file}`));
      break;
    }
  }
}

const version = execFileSync(path.join(dest, 'ffmpeg' + exe), ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
fs.writeFileSync(path.join(dest, 'FFMPEG-SOURCE.txt'), [
  'CutnCrop bundles FFmpeg (https://ffmpeg.org), which is licensed separately from CutnCrop.',
  'See FFMPEG-LICENSE for its license terms.',
  '',
  `Bundled build: ${version}`,
  'Source code: the build page of the binary provider (e.g. https://www.gyan.dev/ffmpeg/builds/)',
  'links the exact FFmpeg sources and configuration used; FFmpeg itself is at https://ffmpeg.org/download.html',
  '',
].join('\n'));
console.log(`license files written to ${dest}`);
