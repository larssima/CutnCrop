// Launch the app. Clears ELECTRON_RUN_AS_NODE, which VS Code sets in its
// terminals and which would make Electron run as plain Node.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
