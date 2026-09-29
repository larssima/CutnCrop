// Copy ffmpeg/ffprobe into vendor/ffmpeg so the installer bundles them.
// Source: CUTNCROP_FFMPEG_DIR, or the binaries found on PATH.

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
for (const name of ['ffmpeg', 'ffprobe']) {
  const src = locate(name);
  fs.copyFileSync(src, path.join(dest, name + exe));
  console.log(`${name}: ${src} -> ${dest}`);
}
