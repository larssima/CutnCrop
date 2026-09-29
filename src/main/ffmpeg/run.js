// Spawn ffmpeg/ffprobe without a shell (no quoting issues) and parse progress.

import { spawn } from 'node:child_process';
import { ffmpegPaths } from './paths.js';

/** Run ffprobe and return stdout. */
export function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPaths().ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => reject(new Error(`Could not start ffprobe: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `ffprobe exited with ${code}`))));
  });
}

/**
 * Run ffmpeg. `duration` (seconds of output) turns -progress output into a
 * 0..1 fraction passed to onProgress. Returns { promise, cancel }.
 */
export function runFfmpeg(args, { duration = 0, onProgress } = {}) {
  const fullArgs = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
  const proc = spawn(ffmpegPaths().ffmpeg, fullArgs, { windowsHide: true });
  let cancelled = false;
  let stderrTail = '';
  let buf = '';

  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && duration > 0 && onProgress) {
        onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    }
  });
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });

  const promise = new Promise((resolve, reject) => {
    proc.on('error', (e) => reject(new Error(`Could not start ffmpeg: ${e.message}`)));
    proc.on('close', (code) => {
      if (cancelled) reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      else if (code === 0) {
        onProgress?.(1);
        resolve();
      } else reject(new Error(lastErrorLines(stderrTail) || `ffmpeg exited with ${code}`));
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      // 'q' on stdin is ignored because of -nostdin; kill is fine since output is discarded.
      proc.kill();
    },
  };
}

function lastErrorLines(text) {
  return text.trim().split(/\r?\n/).slice(-6).join('\n');
}
