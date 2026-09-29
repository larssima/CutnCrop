// Locate ffmpeg/ffprobe. Order: CUTNCROP_FFMPEG_DIR env var, the bundled copy
// (installer: resources/ffmpeg, dev: vendor/ffmpeg), then whatever is on PATH.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const exe = process.platform === 'win32' ? '.exe' : '';

function candidateDirs() {
  const dirs = [];
  if (process.env.CUTNCROP_FFMPEG_DIR) dirs.push(process.env.CUTNCROP_FFMPEG_DIR);
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'ffmpeg'));
  dirs.push(path.join(repoRoot, 'vendor', 'ffmpeg'));
  return dirs;
}

function resolveBinary(name) {
  for (const dir of candidateDirs()) {
    const p = path.join(dir, name + exe);
    if (fs.existsSync(p)) return p;
  }
  return name; // fall back to PATH
}

let cached = null;

export function ffmpegPaths() {
  cached ??= { ffmpeg: resolveBinary('ffmpeg'), ffprobe: resolveBinary('ffprobe') };
  return cached;
}
