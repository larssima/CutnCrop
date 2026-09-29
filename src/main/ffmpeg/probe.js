// ffprobe wrapper: turns a media file into the fields a media entry needs.

import path from 'node:path';
import { runFfprobe } from './run.js';

const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

function parseRate(rate) {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n || 0;
}

/** Snap measured rates like 29.97002997 to the nominal 29.97. */
function nominalRate(fps) {
  const hit = COMMON_RATES.find((r) => Math.abs(r - fps) < 0.02);
  return hit ?? Math.round(fps * 1000) / 1000;
}

function rotationOf(stream) {
  const sd = stream.side_data_list?.find((s) => s.rotation !== undefined);
  if (sd) return Number(sd.rotation);
  return Number(stream.tags?.rotate ?? 0);
}

export async function probe(filePath) {
  const json = await runFfprobe([
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    filePath,
  ]);
  const data = JSON.parse(json);
  const video = data.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new Error(`${path.basename(filePath)} has no video or audio stream`);

  const duration = Number(data.format.duration ?? video?.duration ?? audio?.duration ?? 0);
  if (!(duration > 0)) throw new Error(`${path.basename(filePath)} has no readable duration`);

  if (!video) {
    return {
      path: filePath,
      name: path.basename(filePath),
      duration,
      hasVideo: false,
      hasAudio: true,
      audioChannels: audio.channels ?? 2,
      audioCodec: audio.codec_name,
      container: data.format.format_name,
    };
  }

  const avg = parseRate(video.avg_frame_rate);
  const real = parseRate(video.r_frame_rate);
  const measured = avg || real || 30;
  const rotated = Math.abs(rotationOf(video)) % 180 === 90;

  return {
    path: filePath,
    name: path.basename(filePath),
    duration,
    hasVideo: true,
    fps: nominalRate(measured),
    // Phones often store variable frame rate; avg and nominal rate disagree then.
    vfr: avg > 0 && real > 0 && Math.abs(avg - real) / real > 0.01,
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height,
    videoCodec: video.codec_name,
    hasAudio: Boolean(audio),
    audioChannels: audio?.channels ?? 0,
    audioCodec: audio?.codec_name ?? null,
    container: data.format.format_name,
  };
}
