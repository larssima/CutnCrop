// Importing media and the media bin panel.

import { store } from './store.js';
import { h, $, mediaUrl, toast } from './util.js';
import { MEDIA_DRAG_TYPE } from './timelineView.js';
import { createMedia } from '../../shared/schema.js';
import * as tl from '../../shared/timeline.js';
import { formatDuration } from '../../shared/time.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Probe files and add them to the project; optionally place them on the timeline
 * at time `at`. With an audio `trackId`, files go to that audio track; otherwise
 * video files go to the video track and audio files to the first audio track.
 */
export async function importPaths(paths, at = null, trackId = null) {
  if (!paths.length) return;
  const results = await window.api.probe(paths);
  for (const r of results.filter((r) => !r.ok)) toast(`Couldn't import: ${r.error}`, { error: true, ms: 6000 });
  const media = results.filter((r) => r.ok).map((r) => createMedia(r.info));
  if (!media.length) return;

  let adopted = null;
  store.edit((p) => {
    const firstVideo = media.find((m) => m.hasVideo);
    if (firstVideo && !p.media.some((m) => m.hasVideo) && tl.videoTrack(p).clips.length === 0) {
      // Like most editors: the first video clip defines the project format.
      p.settings.width = even(firstVideo.width);
      p.settings.height = even(firstVideo.height);
      p.settings.fps = firstVideo.fps;
      adopted = p.settings;
    }
    const audioTarget = tl.findTrack(p, trackId)?.type === 'audio' ? trackId : null;
    let cursor = at;
    for (const m of media) {
      tl.addMedia(p, m);
      if (cursor === null) continue;
      const target = audioTarget && m.hasAudio ? audioTarget : null;
      cursor = tl.clipEnd(tl.addClip(p, m.id, cursor, target));
    }
  });
  if (adopted) toast(`Project set to ${adopted.width}×${adopted.height} @ ${adopted.fps} fps to match the first clip`);
  prepare(media);
  if (media.some((m) => m.vfr)) toast('Variable frame rate footage detected — it will be conformed to the project frame rate on export.');
}

/** Ask the main process to create thumbnails and proxies. */
export function prepare(mediaList) {
  window.api.prepareMedia(mediaList.map(({ id, path, duration, hasVideo, hasAudio }) => ({ id, path, duration, hasVideo, hasAudio })));
}

// Waveform peaks per media id: Uint8Array, PEAKS_PER_SECOND values per second.
export const PEAKS_PER_SECOND = 100;
const peaks = new Map();
const peaksLoading = new Set();
const peaksFailed = new Set(); // peaks paths that failed to load; not retried

/** Peaks for a media item if loaded; starts loading otherwise (emits 'peaks' when ready). */
export function getPeaks(media) {
  if (!media?.peaksPath || peaksFailed.has(media.peaksPath)) return null;
  const cached = peaks.get(media.id);
  if (cached) return cached;
  if (!peaksLoading.has(media.id)) {
    peaksLoading.add(media.id);
    const { peaksPath } = media;
    fetch(mediaUrl(peaksPath))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
      .then((buf) => {
        peaks.set(media.id, new Uint8Array(buf));
        store.emit('peaks', media.id);
      })
      .catch(() => peaksFailed.add(peaksPath))
      .finally(() => peaksLoading.delete(media.id));
  }
  return null;
}

export function listenForMediaUpdates() {
  window.api.onMediaUpdate(({ id, thumbPath, peaksPath, proxyPath, proxyProgress, error }) => {
    if (thumbPath || proxyPath || peaksPath) {
      store.patchSilently((p) => {
        const m = tl.findMedia(p, id);
        if (!m) return;
        if (thumbPath) m.thumbPath = thumbPath;
        if (peaksPath) m.peaksPath = peaksPath;
        if (proxyPath) m.proxyPath = proxyPath;
      });
    }
    if (proxyProgress !== undefined || error) store.setMediaStatus(id, { proxyProgress, error });
    if (error) toast(error, { error: true });
  });
}

export class MediaBin {
  constructor(root) {
    this.list = $('.media-list', root);
    store.on('project', () => this.render());
    store.on('selection', () => this.render());
    store.on('media-status', () => this.render());
    this.render();
  }

  render() {
    const { media } = store.project;
    if (!media.length) {
      this.list.replaceChildren(h('div.empty-hint', {}, 'Drop video files here', h('br'), 'or use Import (Ctrl+I)'));
      return;
    }
    const sel = store.selection;
    this.list.replaceChildren(
      ...media.map((m) => {
        const status = store.mediaStatus.get(m.id) ?? {};
        const selected = sel?.kind === 'media' && sel.id === m.id;
        const used = tl.clipTracks(store.project).some((t) => t.clips.some((c) => c.mediaId === m.id));
        return h(`div.media-card${selected ? '.selected' : ''}`, {
          draggable: true,
          title: m.path,
          onclick: () => store.select({ kind: 'media', id: m.id }),
          ondblclick: () => {
            const clip = store.edit((p) => tl.addClip(p, m.id));
            store.select({ kind: 'clip', id: clip.id });
          },
          ondragstart: (e) => {
            e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id);
            e.dataTransfer.effectAllowed = 'copy';
          },
        },
          m.hasVideo
            ? h('div.media-thumb', { style: m.thumbPath ? { backgroundImage: `url("${mediaUrl(m.thumbPath)}")` } : {} })
            : h('div.media-thumb.audio', {}, '♪'),
          h('div.media-info', {},
            h('div.media-name', {}, m.name),
            h('div.media-meta', {}, m.hasVideo
              ? `${m.width}×${m.height} · ${m.fps} fps · ${formatDuration(m.duration)}`
              : `Audio · ${formatDuration(m.duration)}`),
            h('div.media-badges', {},
              used ? h('span.badge', {}, 'in use') : null,
              m.hasVideo && !m.hasAudio ? h('span.badge', {}, 'no audio') : null,
              m.vfr ? h('span.badge.warn', { title: 'Variable frame rate' }, 'VFR') : null,
              status.error ? h('span.badge.error', { title: status.error }, 'error') : null,
            ),
            !m.proxyPath && !status.error
              ? h('div.progress.small', { title: 'Generating preview proxy' },
                  h('div.progress-bar', { style: { width: `${Math.round((status.proxyProgress ?? 0) * 100)}%` } }))
              : null,
          ),
        );
      }),
    );
  }
}
