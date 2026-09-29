// Right-hand panel: edit whatever is selected, or the project settings.

import { store } from './store.js';
import { h, $ } from './util.js';
import * as tl from '../../shared/timeline.js';
import { formatTimecode, formatDuration } from '../../shared/time.js';

const RESOLUTIONS = [
  ['1920x1080', '1080p (1920×1080)'],
  ['1280x720', '720p (1280×720)'],
  ['3840x2160', '4K UHD (3840×2160)'],
  ['1080x1920', 'Vertical 1080×1920'],
  ['1080x1080', 'Square 1080×1080'],
];
const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function field(label, input) {
  return h('label.field', {}, h('span.field-label', {}, label), input);
}

/** Number input that commits one undo step on change. */
function numberInput(value, onCommit, { step = 0.01, min = 0, max } = {}) {
  return h('input', {
    type: 'number', value: Number(value.toFixed(3)), step, min, max,
    onchange: (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v)) onCommit(v);
    },
  });
}

/** Slider with live preview while dragging and a single undo step at the end. */
function slider(value, onPreview, { min = 0, max = 1, step = 0.01, format = (v) => v } = {}) {
  const out = h('span.slider-value', {}, format(value));
  const input = h('input', {
    type: 'range', min, max, step, value,
    oninput: (e) => {
      out.textContent = format(Number(e.target.value));
      store.preview((p) => onPreview(p, Number(e.target.value)));
    },
    onchange: () => store.endGesture(),
  });
  return h('div.slider', {}, input, out);
}

export class Inspector {
  constructor(root) {
    this.root = $('.inspector-body', root);
    this.title = $('.inspector-title', root);
    store.on('selection', () => this.render());
    store.on('project', () => {
      // Don't rebuild a field the user is typing in or dragging.
      const active = document.activeElement;
      const editing = this.root.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && active.type !== 'checkbox';
      if (!editing) this.render();
    });
    store.on('media-status', () => {
      if (store.selection?.kind === 'media') this.render();
    });
    this.render();
  }

  render() {
    const s = store.selection;
    const p = store.project;
    if (s?.kind === 'clip' && tl.findClip(p, s.id)) return this.renderClip(tl.findClip(p, s.id));
    if (s?.kind === 'text' && tl.findText(p, s.id)) return this.renderText(tl.findText(p, s.id));
    if (s?.kind === 'media' && tl.findMedia(p, s.id)) return this.renderMedia(tl.findMedia(p, s.id));
    return this.renderProject();
  }

  show(title, ...children) {
    this.title.textContent = title;
    this.root.replaceChildren(...children.filter(Boolean));
  }

  renderProject() {
    const p = store.project;
    const { width, height, fps } = p.settings;
    const resKey = `${width}x${height}`;
    const resOptions = RESOLUTIONS.some(([k]) => k === resKey) ? RESOLUTIONS : [[resKey, `Custom (${width}×${height})`], ...RESOLUTIONS];
    const fpsOptions = FRAME_RATES.includes(fps) ? FRAME_RATES : [fps, ...FRAME_RATES];
    this.show('Project',
      field('Resolution', h('select', {
        onchange: (e) => {
          const [w, hgt] = e.target.value.split('x').map(Number);
          store.edit((proj) => Object.assign(proj.settings, { width: w, height: hgt }));
        },
      }, ...resOptions.map(([k, label]) => h('option', { value: k, selected: k === resKey }, label)))),
      field('Frame rate', h('select', {
        onchange: (e) => store.edit((proj) => (proj.settings.fps = Number(e.target.value))),
      }, ...fpsOptions.map((r) => h('option', { value: r, selected: r === fps }, `${r} fps`)))),
      h('div.info-grid', {},
        h('span', {}, 'Duration'), h('span', {}, formatTimecode(tl.projectDuration(p), fps)),
        h('span', {}, 'Video clips'), h('span', {}, tl.videoTrack(p).clips.length),
        h('span', {}, 'Audio clips'), h('span', {}, tl.audioTracks(p).reduce((n, t) => n + t.clips.length, 0)),
        h('span', {}, 'Media'), h('span', {}, p.media.length),
      ),
      h('p.hint', {}, 'Select a clip, text or media item to edit it.'),
    );
  }

  renderClip(clip) {
    const p = store.project;
    const media = tl.findMedia(p, clip.mediaId);
    const fps = p.settings.fps;
    const track = tl.trackOfClip(p, clip.id);
    const isAudio = track.type === 'audio';
    // Volume and mute live on the audio clip; for a video clip they edit its linked audio.
    const audio = tl.audioClipsOf(p, clip)[0];
    const audioControls = [];
    if (audio) {
      audioControls.push(
        h('label.checkbox', {},
          h('input', {
            type: 'checkbox', checked: audio.muted,
            onchange: (e) => store.edit((proj) => tl.setClipMuted(proj, clip.id, e.target.checked)),
          }),
          isAudio ? 'Mute (M)' : 'Mute clip sound (M)'),
        field(isAudio ? 'Volume' : 'Clip sound volume', slider(audio.volume, (proj, v) => tl.setClipVolume(proj, clip.id, v), {
          min: 0, max: 2, step: 0.01, format: (v) => `${Math.round(v * 100)}%`,
        })),
      );
    }
    if (isAudio) {
      audioControls.push(
        field('Fade in (s)', numberInput(clip.fadeIn, (v) => store.edit((proj) => tl.setClipFades(proj, clip.id, { fadeIn: v })), { step: 0.1 })),
        field('Fade out (s)', numberInput(clip.fadeOut, (v) => store.edit((proj) => tl.setClipFades(proj, clip.id, { fadeOut: v })), { step: 0.1 })),
      );
    } else if (!media.hasAudio) {
      audioControls.push(h('p.hint', {}, 'This clip has no audio.'));
    } else if (!audio) {
      audioControls.push(h('p.hint', {}, 'Unlinked — its sound is a separate clip on an audio track (or was deleted).'));
    }
    const linkNote = clip.linkId
      ? h('p.hint', {}, isAudio
          ? '🔗 Linked to its video: moves, trims and splits with it.'
          : `🔗 Sound on ${tl.trackOfClip(p, audio.id).id.toUpperCase()}: moves, trims and splits with it.`)
      : null;
    this.show(isAudio ? `Audio clip · ${track.id.toUpperCase()}` : 'Video clip',
      h('div.inspector-name', { title: media.path }, media.name),
      linkNote,
      ...audioControls,
      field('Start on timeline (s)', numberInput(clip.start, (v) => store.edit((proj) => tl.moveClip(proj, clip.id, v)))),
      field('In point (s)', numberInput(clip.in, (v) => store.edit((proj) => tl.trimClip(proj, clip.id, 'in', clip.start + (v - clip.in))), { max: clip.out })),
      field('Out point (s)', numberInput(clip.out, (v) => store.edit((proj) => tl.trimClip(proj, clip.id, 'out', clip.start + (v - clip.in))), { max: media.duration })),
      h('div.info-grid', {},
        h('span', {}, 'Duration'), h('span', {}, formatTimecode(tl.clipDuration(clip), fps)),
        h('span', {}, 'Source'), h('span', {}, media.hasVideo ? `${media.width}×${media.height} @ ${media.fps}` : 'Audio file'),
      ),
      h('div.button-row', {},
        h('button', { onclick: () => store.emit('command', 'split') }, 'Split at playhead'),
        clip.linkId
          ? h('button', { onclick: () => store.emit('command', 'unlink'), title: 'Edit video and audio separately (D)' }, 'Unlink')
          : null,
        h('button.danger', { onclick: () => store.emit('command', 'delete') }, 'Delete'),
      ),
    );
  }

  renderText(item) {
    const update = (changes) => store.edit((proj) => tl.updateText(proj, item.id, changes));
    const live = (key) => (proj, v) => tl.updateText(proj, item.id, { [key]: v });
    this.show('Text',
      field('Text', h('textarea', { rows: 3, value: item.text, onchange: (e) => update({ text: e.target.value }) })),
      field('Start (s)', numberInput(item.start, (v) => update({ start: v, end: Math.max(item.end, v + 0.1) }))),
      field('End (s)', numberInput(item.end, (v) => update({ end: v }))),
      field('Size (px)', numberInput(item.size, (v) => update({ size: Math.max(4, Math.round(v)) }), { step: 1, min: 4 })),
      field('Color', h('input', { type: 'color', value: item.color, onchange: (e) => update({ color: e.target.value }) })),
      field('Horizontal position', slider(item.x, live('x'), { format: (v) => `${Math.round(v * 100)}%` })),
      field('Vertical position', slider(item.y, live('y'), { format: (v) => `${Math.round(v * 100)}%` })),
      h('div.button-row', {},
        h('button.danger', { onclick: () => store.emit('command', 'delete') }, 'Delete'),
      ),
    );
  }

  renderMedia(media) {
    const status = store.mediaStatus.get(media.id) ?? {};
    this.show('Media',
      h('div.inspector-name', {}, media.name),
      h('div.info-grid', {},
        ...(media.hasVideo
          ? [
              h('span', {}, 'Resolution'), h('span', {}, `${media.width}×${media.height}`),
              h('span', {}, 'Frame rate'), h('span', {}, `${media.fps} fps${media.vfr ? ' (variable)' : ''}`),
            ]
          : [h('span', {}, 'Type'), h('span', {}, 'Audio file')]),
        h('span', {}, 'Duration'), h('span', {}, formatDuration(media.duration)),
        h('span', {}, 'Audio'), h('span', {}, media.hasAudio ? (media.audioChannels === 1 ? 'Mono' : 'Stereo') : 'None'),
        h('span', {}, 'Preview'), h('span', {}, media.proxyPath ? 'Proxy ready' : status.error ? 'Failed' : `Generating… ${Math.round((status.proxyProgress ?? 0) * 100)}%`),
      ),
      h('div.path', {}, media.path),
      h('div.button-row', {},
        h('button', { onclick: () => store.edit((p) => tl.addClip(p, media.id)) }, 'Add to timeline'),
        h('button.danger', { onclick: () => store.emit('command', 'delete') }, 'Remove'),
      ),
    );
  }
}
