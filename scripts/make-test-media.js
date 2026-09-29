// Generate short synthetic clips in test-media/ covering the formats the editor
// must handle. Run: npm run test-media   (skips files that already exist)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegPaths } from '../src/main/ffmpeg/paths.js';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-media');

const tone = (freq, d) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${d}`];
const bars = (size, rate, d) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${d}`];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
const aac = ['-c:a', 'aac', '-b:a', '128k'];

export const TEST_MEDIA = {
  'cfr24_1080p.mp4': [...bars('1920x1080', 24, 5), ...tone(440, 5), ...h264, ...aac, '-shortest'],
  'cfr25_720p.mp4': [...bars('1280x720', 25, 5), ...tone(550, 5), ...h264, ...aac, '-shortest'],
  'ntsc2997_640.mp4': [...bars('640x360', '30000/1001', 5), ...tone(660, 5), ...h264, ...aac, '-shortest'],
  'cfr60_640.mp4': [...bars('640x360', 60, 5), ...tone(770, 5), ...h264, ...aac, '-shortest'],
  'vertical_360x640.mp4': [...bars('360x640', 30, 4), ...tone(880, 4), ...h264, ...aac, '-shortest'],
  'noaudio_640.mp4': [...bars('640x360', 30, 4), ...h264],
  // Phone-style variable frame rate: 2 s at 30 fps, then 3 s at 15 fps.
  'vfr_640.mp4': [
    ...bars('640x360', 30, 5), ...tone(990, 5),
    '-vf', "select='lt(n\\,60)+not(mod(n\\,2))'", '-fps_mode', 'vfr', ...h264, ...aac, '-shortest',
  ],
  // Sync reference: one white frame and a 50 ms beep at every whole second.
  'sync_30.mp4': [
    '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=8',
    '-vf', "drawbox=c=white:t=fill:enable='lt(mod(n\\,30)\\,1)'",
    '-af', "volume='if(lt(mod(t\\,1)\\,0.05)\\,1\\,0)':eval=frame",
    ...h264, ...aac, '-shortest',
  ],
  // Audio-only: beeps on every whole second (sync reference) and a plain tone.
  'beeps.wav': [
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=8',
    '-af', "volume='if(lt(mod(t\\,1)\\,0.05)\\,1\\,0)':eval=frame", '-c:a', 'pcm_s16le',
  ],
  'tone.mp3': [...tone(440, 6), '-c:a', 'libmp3lame', '-b:a', '128k'],
  'webm_vp9_640.webm': [
    ...bars('640x360', 30, 4), ...tone(330, 4),
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k', '-c:a', 'libopus',
  ],
};

// Portrait phone footage is usually landscape pixels plus a rotation flag.
const ROTATED = { 'rotated_phone.mp4': { from: 'cfr25_720p.mp4', rotation: 90 } };

function ffmpeg(args) {
  const r = spawnSync(ffmpegPaths().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `ffmpeg failed (${r.error?.message})`);
}

export function makeTestMedia({ quiet = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const log = quiet ? () => {} : console.log;
  for (const [name, args] of Object.entries(TEST_MEDIA)) {
    const out = path.join(outDir, name);
    if (fs.existsSync(out)) continue;
    log(`creating ${name}`);
    ffmpeg([...args, out]);
  }
  for (const [name, { from, rotation }] of Object.entries(ROTATED)) {
    const out = path.join(outDir, name);
    if (fs.existsSync(out)) continue;
    log(`creating ${name}`);
    ffmpeg(['-display_rotation', String(rotation), '-i', path.join(outDir, from), '-c', 'copy', out]);
  }
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeTestMedia();
  console.log(`test media ready in ${outDir}`);
}
