// Run an export: write overlay text files, run ffmpeg, report progress.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExportCommand } from './buildCommand.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { validateProject } from '../../shared/schema.js';

/**
 * Start exporting. Returns { promise, cancel }. On failure or cancel the
 * partial output file is removed.
 */
export function startExport(project, outPath, { quality, onProgress } = {}) {
  let job = null;
  let cancelled = false;
  let tempDir = null;

  const promise = (async () => {
    const errors = validateProject(project);
    if (errors.length) throw new Error(`Project is invalid:\n${errors.join('\n')}`);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutncrop-export-'));
    const cmd = buildExportCommand(project, outPath, { tempDir, quality });
    for (const f of cmd.textFiles) await fs.writeFile(f.path, f.content, 'utf8');
    if (cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });

    job = runFfmpeg(cmd.args, { duration: cmd.duration, onProgress });
    await job.promise;
    return { outPath, duration: cmd.duration };
  })();

  const cleaned = promise
    .catch(async (err) => {
      await fs.rm(outPath, { force: true }).catch(() => {});
      throw err;
    })
    .finally(() => tempDir && fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}));

  return {
    promise: cleaned,
    cancel() {
      cancelled = true;
      job?.cancel();
    },
  };
}
