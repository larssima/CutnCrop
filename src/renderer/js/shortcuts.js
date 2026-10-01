// The keyboard and mouse reference shown under Help › Keyboard shortcuts (F1).
// Keep in sync with the key handler in app.js and the menus in clipMenus.js.

import { h, $ } from './util.js';

export const SHORTCUTS = [
  {
    group: 'File',
    items: [
      ['Ctrl+N', 'New project'],
      ['Ctrl+O', 'Open project'],
      ['Ctrl+S', 'Save project'],
      ['Ctrl+Shift+S', 'Save project as'],
      ['Ctrl+I', 'Import media'],
      ['Ctrl+E', 'Export video'],
    ],
  },
  {
    group: 'Editing',
    items: [
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Y  /  Ctrl+Shift+Z', 'Redo'],
      ['S', 'Split at playhead'],
      ['Ctrl+D', 'Duplicate selected clip or text'],
      ['Del  /  Backspace', 'Delete selection'],
      ['Shift+Del', 'Ripple delete (close the gap on all lanes)'],
      ['D', 'Unlink a clip from its sound'],
      ['M', 'Mute / unmute the selected clip\'s sound'],
      ['T', 'Add text at playhead'],
    ],
  },
  {
    group: 'Playback',
    items: [
      ['Space  /  K', 'Play / pause'],
      ['←  /  →', 'Previous / next frame'],
      ['Shift+←  /  Shift+→', 'Back / forward one second'],
      ['Home  /  End', 'Go to start / end'],
      ['Esc', 'Leave the source preview (back to the timeline)'],
    ],
  },
  {
    group: 'Timeline view',
    items: [
      ['+  /  −', 'Zoom in / out'],
      ['\\', 'Zoom to fit'],
      ['Ctrl+mouse wheel', 'Zoom around the pointer'],
      ['Mouse wheel', 'Scroll the timeline'],
    ],
  },
  {
    group: 'Mouse',
    items: [
      ['Click media file', 'Preview it without adding it to the timeline'],
      ['Double-click media file', 'Add it to the end of the timeline'],
      ['Drag media file to a lane', 'Place it there'],
      ['Drag files from Explorer', 'Import (onto a lane: also place them)'],
      ['Click video clip', 'Select it with its sound'],
      ['Ctrl+click video clip', 'Select the video only'],
      ['Drag clip', 'Move (snaps to playhead and clip edges)'],
      ['Drag clip edge', 'Trim'],
      ['Drag sound clip up/down', 'Move it to another audio lane'],
      ['Drag round handles on sound clip', 'Fade in / fade out'],
      ['Click / drag the ruler', 'Move the playhead / scrub'],
      ['Right-click clip, text or media file', 'Menu with everything you can do with it'],
    ],
  },
  {
    group: 'Help',
    items: [['F1  /  ?', 'This chart']],
  },
];

export class ShortcutsDialog {
  constructor(root) {
    this.root = root;
    $('.shortcuts-close', root).addEventListener('click', () => root.close());
    $('.shortcuts-body', root).append(
      ...SHORTCUTS.map(({ group, items }) =>
        h('section.shortcut-group', {},
          h('h3', {}, group),
          h('dl', {}, ...items.flatMap(([keys, what]) => [
            h('dt', {}, ...keys.split('  /  ').flatMap((k, i) => [i ? ' / ' : null, h('kbd', {}, k)])),
            h('dd', {}, what),
          ])),
        ),
      ),
    );
  }

  open() {
    if (!this.root.open) this.root.showModal();
  }
}
