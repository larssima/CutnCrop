// Time and frame-rate helpers. All timeline times are seconds (floats), but every
// edit is snapped to the project's frame grid so export stays frame-accurate.

/**
 * Convert a frame rate like 29.97 or 23.976 to an exact rational (30000/1001).
 * Integer rates stay integer (30 -> 30/1).
 */
export function fpsRational(fps) {
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  const ntsc = fps * 1.001;
  if (Math.abs(ntsc - Math.round(ntsc)) < 0.01) {
    return { num: Math.round(ntsc) * 1000, den: 1001 };
  }
  // Arbitrary rate: approximate with millisecond precision.
  return { num: Math.round(fps * 1000), den: 1000 };
}

/** "30000/1001" style string for ffmpeg. */
export function fpsString(fps) {
  const { num, den } = fpsRational(fps);
  return den === 1 ? String(num) : `${num}/${den}`;
}

export function exactFps(fps) {
  const { num, den } = fpsRational(fps);
  return num / den;
}

/** Nearest whole frame count for a duration in seconds. */
export function frameCount(seconds, fps) {
  return Math.round(seconds * exactFps(fps) + 1e-9);
}

export function framesToSeconds(frames, fps) {
  const { num, den } = fpsRational(fps);
  return round6((frames * den) / num);
}

/** Snap a time to the nearest frame boundary. */
export function snapToFrame(seconds, fps) {
  return framesToSeconds(frameCount(seconds, fps), fps);
}

/** Snap down to a frame boundary (used when a time must not exceed a limit). */
export function floorToFrame(seconds, fps) {
  return framesToSeconds(Math.floor(seconds * exactFps(fps) + 1e-6), fps);
}

export function frameDuration(fps) {
  return framesToSeconds(1, fps);
}

/** Exact audio sample count for a whole number of video frames, so A/V lengths match. */
export function samplesForFrames(frames, fps, sampleRate) {
  const { num, den } = fpsRational(fps);
  return Math.round((frames * den * sampleRate) / num);
}

/** HH:MM:SS:FF timecode. */
export function formatTimecode(seconds, fps) {
  const rate = Math.round(exactFps(fps));
  const total = frameCount(Math.max(0, seconds), fps);
  const ff = total % rate;
  const s = Math.floor(total / rate);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`;
}

/** Short human duration, e.g. "1:05.3". */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}
