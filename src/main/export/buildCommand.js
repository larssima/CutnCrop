// Translate a project into ffmpeg arguments. Pure: no I/O, so it can be unit
// tested. Text overlays are read from text files (drawtext textfile=) to avoid
// ffmpeg's escaping rules; the caller writes `textFiles` before running.
//
// Strategy: the video track becomes a list of segments (clips and gaps). Every
// segment is normalized to the project format (fps, size, pixel format) and
// forced to an exact frame count, then the segments are concatenated.
//
// All sound lives on audio tracks (a video clip's own sound is a linked audio
// clip). Each audio clip is cut to an exact sample count, faded, and delayed by
// an exact number of samples derived from the same frame grid as the video, so
// A/V sync is exact. Clips are summed over a silent bed spanning the timeline
// (amix without normalization, so levels don't change).

import path from 'node:path';
import { sortedClips, textTrack, findMedia, clipEnd, audioTracks, projectDuration, clipDuration } from '../../shared/timeline.js';
import { fpsString, frameCount, framesToSeconds, samplesForFrames } from '../../shared/time.js';

const DEFAULT_FONT = process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : null;

export const QUALITY_PRESETS = {
  high: { crf: 18, preset: 'slow' },
  standard: { crf: 20, preset: 'medium' },
  fast: { crf: 23, preset: 'veryfast' },
  draft: { crf: 28, preset: 'ultrafast' },
};

/** Quote a path for use as a filter option value (drawtext fontfile/textfile). */
export function filterPath(p) {
  const s = p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''");
  return `'${s}'`;
}

function hexColor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color ?? '');
  return m ? `0x${m[1]}` : 'white';
}

const num = (x) => Number(x.toFixed(6));

/**
 * Split the video track into contiguous segments, measured in whole frames.
 * A trailing gap extends the video when audio runs past the last video clip.
 */
export function buildSegments(project) {
  const { fps } = project.settings;
  const segments = [];
  let cursor = 0; // in frames
  for (const clip of sortedClips(project)) {
    const startF = frameCount(clip.start, fps);
    const endF = frameCount(clipEnd(clip), fps);
    if (endF <= startF) continue;
    if (startF > cursor) segments.push({ type: 'gap', startF: cursor, endF: startF });
    const s = Math.max(startF, cursor); // defensive: overlaps should not exist
    segments.push({ type: 'clip', clip, startF: s, endF, skipF: s - startF });
    cursor = endF;
  }
  const totalF = frameCount(projectDuration(project), fps);
  if (totalF > cursor) segments.push({ type: 'gap', startF: cursor, endF: totalF });
  return segments;
}

/**
 * @param {object} project
 * @param {string} outPath
 * @param {object} opts  { tempDir, quality, fontFile }
 * @returns {{ args: string[], duration: number, textFiles: {path: string, content: string}[] }}
 */
export function buildExportCommand(project, outPath, opts = {}) {
  const { width: W, height: H, fps, sampleRate: SR } = project.settings;
  const R = fpsString(fps);
  const quality = QUALITY_PRESETS[opts.quality ?? 'standard'];
  const fontFile = opts.fontFile === undefined ? DEFAULT_FONT : opts.fontFile;
  const tempDir = opts.tempDir ?? '.';

  const segments = buildSegments(project);
  if (segments.length === 0) throw new Error('The timeline is empty — add a clip before exporting.');
  const totalFrames = segments.at(-1).endF;

  const inputArgs = [];
  const filters = [];
  const concatInputs = [];
  let inputIndex = 0;
  const addInput = (media, seek, dur) => {
    // Read a little past the out point; exact lengths are enforced by trim filters.
    inputArgs.push('-ss', seek.toFixed(6), '-t', (dur + 0.25).toFixed(6), '-i', media.path);
    return inputIndex++;
  };
  // Mono is copied to both channels at full level; the default upmix would be 3 dB quieter.
  const normalizedAudio = (i, media, volume, samples) =>
    `[${i}:a:0]aresample=${SR}:async=1:first_pts=0,` +
    (media.audioChannels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : '') +
    `aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${volume},` +
    `apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=PTS-STARTPTS`;

  // ---- Video track ----
  segments.forEach((seg, k) => {
    const frames = seg.endF - seg.startF;
    const v = `v${k}`;
    if (seg.type === 'gap') {
      filters.push(`color=c=black:s=${W}x${H}:r=${R},format=yuv420p,setsar=1,trim=end_frame=${frames}[${v}]`);
    } else {
      const { clip } = seg;
      const media = findMedia(project, clip.mediaId);
      const i = addInput(media, clip.in + framesToSeconds(seg.skipF, fps), framesToSeconds(frames, fps));
      filters.push(
        `[${i}:v:0]fps=fps=${R}:start_time=0,` +
          `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
          `tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},setpts=PTS-STARTPTS[${v}]`,
      );
    }
    concatInputs.push(`[${v}]`);
  });
  filters.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=0[vcat]`);

  // ---- Audio tracks, mixed over a silent bed as long as the timeline ----
  const totalSamples = samplesForFrames(totalFrames, fps, SR);
  filters.push(`anullsrc=r=${SR}:cl=stereo,aformat=sample_fmts=fltp,atrim=end_sample=${totalSamples}[abed]`);
  const mixInputs = ['[abed]'];
  for (const track of audioTracks(project)) {
    if (track.muted) continue;
    for (const clip of sortedClips(project, track)) {
      if (clip.muted) continue;
      const media = findMedia(project, clip.mediaId);
      const startF = frameCount(clip.start, fps);
      const endF = Math.min(frameCount(clipEnd(clip), fps), totalFrames);
      if (endF <= startF || !media?.hasAudio) continue;
      const delay = samplesForFrames(startF, fps, SR);
      const samples = samplesForFrames(endF, fps, SR) - delay;
      const dur = samples / SR;
      const i = addInput(media, clip.in, dur);
      const label = `t${mixInputs.length}`;
      let chain = normalizedAudio(i, media, clip.volume ?? 1, samples);
      const fadeIn = Math.min(clip.fadeIn ?? 0, dur);
      const fadeOut = Math.min(clip.fadeOut ?? 0, clipDuration(clip));
      if (fadeIn > 0) chain += `,afade=t=in:st=0:d=${num(fadeIn)}`;
      if (fadeOut > 0) chain += `,afade=t=out:st=${num(Math.max(0, clipDuration(clip) - fadeOut))}:d=${num(fadeOut)}`;
      if (delay > 0) chain += `,adelay=delays=${delay}S:all=1`;
      filters.push(`${chain}[${label}]`);
      mixInputs.push(`[${label}]`);
    }
  }
  if (mixInputs.length > 1) {
    filters.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0,` +
        `atrim=end_sample=${totalSamples}[aout]`,
    );
  } else {
    filters.push('[abed]anull[aout]');
  }

  // ---- Text overlays, drawn on top of the concatenated video ----
  const textFiles = [];
  let vLabel = 'vcat';
  textTrack(project).items.forEach((item, n) => {
    if (!item.text?.trim()) return;
    const textPath = path.join(tempDir, `text-${n}.txt`);
    textFiles.push({ path: textPath, content: item.text });
    const border = Math.max(1, Math.round(item.size / 16));
    const font = fontFile ? `fontfile=${filterPath(fontFile)}` : 'font=Sans';
    const next = `vt${n}`;
    filters.push(
      `[${vLabel}]drawtext=${font}:textfile=${filterPath(textPath)}:expansion=none:` +
        `fontsize=${item.size}:fontcolor=${hexColor(item.color)}:borderw=${border}:bordercolor=black@0.8:` +
        `x=w*${item.x}-text_w/2:y=h*${item.y}-text_h/2:` +
        `enable='between(t,${item.start},${item.end})'[${next}]`,
    );
    vLabel = next;
  });

  const args = [
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', `[${vLabel}]`,
    '-map', '[aout]',
    '-c:v', 'libx264', '-preset', quality.preset, '-crf', String(quality.crf),
    '-pix_fmt', 'yuv420p', '-r', R,
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-ac', '2',
    // negative_cts_offsets: B-frame reordering is stored so the first frame sits at
    // time 0 without an MP4 edit list. Players that ignore edit lists would otherwise
    // show the picture ~67 ms late, i.e. sound visibly ahead of the lips. (AAC priming
    // still uses a standard edit list; ignoring that only delays audio by 21 ms.)
    '-movflags', '+faststart+negative_cts_offsets',
    outPath,
  ];

  return { args, duration: framesToSeconds(totalFrames, fps), textFiles };
}
