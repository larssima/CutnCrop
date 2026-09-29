// Export dialog: pick quality and file, then show progress with cancel.

import { store } from './store.js';
import { $, toast } from './util.js';
import { projectDuration } from '../../shared/timeline.js';
import { formatDuration } from '../../shared/time.js';

export class ExportDialog {
  constructor(root) {
    this.root = root;
    this.running = false;
    this.bar = $('.progress-bar', root);
    this.status = $('.export-status', root);
    this.summary = $('.export-summary', root);
    this.quality = $('select[name=quality]', root);
    this.startBtn = $('.export-start', root);
    this.cancelBtn = $('.export-cancel', root);
    this.showBtn = $('.export-show', root);

    this.startBtn.addEventListener('click', () => this.start());
    this.cancelBtn.addEventListener('click', () => (this.running ? window.api.cancelExport() : this.close()));
    this.showBtn.addEventListener('click', () => window.api.showItemInFolder(this.outPath));
    window.api.onExportProgress((p) => this.progress(p));
  }

  open() {
    const duration = projectDuration(store.project);
    if (duration <= 0) {
      toast('The timeline is empty — add a clip first.', { error: true });
      return;
    }
    const { width, height, fps } = store.project.settings;
    this.summary.textContent = `${width}×${height} · ${fps} fps · ${formatDuration(duration)} · MP4 (H.264 / AAC)`;
    this.setState('idle');
    this.root.showModal();
  }

  close() {
    if (!this.running) this.root.close();
  }

  setState(state, message = '') {
    this.root.dataset.state = state;
    this.running = state === 'running';
    this.startBtn.hidden = state === 'running' || state === 'done';
    this.showBtn.hidden = state !== 'done';
    this.cancelBtn.textContent = state === 'running' ? 'Cancel' : 'Close';
    this.quality.disabled = state === 'running';
    this.status.textContent = message;
    if (state !== 'running' && state !== 'done') this.bar.style.width = '0%';
  }

  progress(p) {
    this.bar.style.width = `${(p * 100).toFixed(1)}%`;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const eta = p > 0.02 ? (elapsed / p) * (1 - p) : null;
    this.status.textContent = `${Math.round(p * 100)}%` + (eta !== null ? ` — about ${Math.ceil(eta)} s left` : '');
  }

  async start() {
    const base = store.filePath ? store.filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : 'Untitled';
    const outPath = await window.api.pickExportPath(`${base}.mp4`);
    if (!outPath) return;
    this.outPath = outPath;
    this.setState('running', 'Starting…');
    this.startedAt = performance.now();
    try {
      const result = await window.api.startExport({ project: store.project, outPath, quality: this.quality.value });
      if (result?.cancelled) this.setState('idle', 'Export cancelled.');
      else {
        this.setState('done', `Done in ${((performance.now() - this.startedAt) / 1000).toFixed(1)} s — ${outPath}`);
        this.bar.style.width = '100%';
      }
    } catch (e) {
      this.setState('error', `Export failed: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }
  }
}
