import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegPaths } from '../../src/main/ffmpeg/paths.js';
import { probe } from '../../src/main/ffmpeg/probe.js';
import { createProject, createMedia } from '../../src/shared/schema.js';
import { makeTestMedia } from '../../scripts/make-test-media.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const outputDir = path.join(root, 'test-output');
export const samplesDir = path.join(root, 'Samples');

export function hasFfmpeg() {
  return spawnSync(ffmpegPaths().ffmpeg, ['-version']).status === 0;
}

export function setup() {
  fs.mkdirSync(outputDir, { recursive: true });
  return makeTestMedia({ quiet: true });
}

export async function mediaFrom(filePath) {
  return createMedia(await probe(filePath));
}

export function newProject(settings) {
  return createProject({ width: 640, height: 360, fps: 30, ...settings });
}

export function outFile(name) {
  return path.join(outputDir, name);
}

/** Stream facts for verifying an export. Frame counts come from packet counting. */
export function inspect(file) {
  const r = spawnSync(ffmpegPaths().ffprobe, [
    '-v', 'error', '-count_packets',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_packets,duration,sample_rate,channels',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const data = JSON.parse(r.stdout);
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  return {
    width: v.width,
    height: v.height,
    fps: v.r_frame_rate,
    frames: Number(v.nb_read_packets),
    videoDuration: Number(v.duration),
    audioDuration: a ? Number(a.duration) : null,
    audioRate: a ? Number(a.sample_rate) : null,
    channels: a?.channels ?? null,
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name ?? null,
  };
}

/**
 * Timestamps of frames whose average luma is bright (the sync flashes).
 * ignoreEditList reads the file like players that ignore MP4 edit lists.
 */
export function flashTimes(file, { ignoreEditList = false } = {}) {
  const r = spawnSync(ffmpegPaths().ffmpeg, [
    '-hide_banner', ...(ignoreEditList ? ['-ignore_editlist', '1'] : []), '-i', file,
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-an', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const times = [];
  let pts = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const f = /pts_time:([\d.]+)/.exec(line);
    if (f) pts = Number(f[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && Number(y[1]) > 128) times.push(pts);
  }
  return times;
}

/** Mean and max volume (dB) of the audio in [start, start + dur). */
export function volumeStats(file, start = 0, dur = null) {
  const r = spawnSync(ffmpegPaths().ffmpeg, [
    '-hide_banner', '-ss', String(start), ...(dur ? ['-t', String(dur)] : []), '-i', file, '-vn',
    '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const mean = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1];
  const max = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1];
  const toNum = (s) => (s === undefined || s === '-inf' ? -Infinity : Number(s));
  return { mean: toNum(mean), max: toNum(max) };
}

/** Start times of beeps, found as the ends of silent stretches. */
export function beepTimes(file) {
  const r = spawnSync(ffmpegPaths().ffmpeg, [
    '-hide_banner', '-i', file, '-vn',
    '-af', 'silencedetect=noise=-30dB:duration=0.02', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
}
