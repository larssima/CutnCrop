// Small popup menu. showContextMenu(x, y, items) where each item is
//   { label, shortcut?, action, disabled?, danger? }  or  '-' for a separator.
// Closes on choosing an item, clicking elsewhere, Esc, scrolling or resizing.

import { h } from './util.js';

let current = null;

export function closeContextMenu() {
  if (!current) return;
  current.el.remove();
  for (const [target, type, fn, opts] of current.listeners) target.removeEventListener(type, fn, opts);
  current = null;
}

export function isContextMenuOpen() {
  return current !== null;
}

export function showContextMenu(x, y, items) {
  closeContextMenu();
  const entries = items.filter(Boolean);
  const el = h('div.context-menu', { role: 'menu' },
    ...entries.map((item) => {
      if (item === '-') return h('div.context-sep', { role: 'separator' });
      return h(`button.context-item${item.danger ? '.danger' : ''}`, {
        role: 'menuitem',
        disabled: Boolean(item.disabled),
        onclick: () => {
          closeContextMenu();
          item.action();
        },
      }, h('span.context-label', {}, item.label), item.shortcut ? h('span.context-shortcut', {}, item.shortcut) : null);
    }),
  );
  document.body.append(el);

  // Keep the menu on screen.
  const { innerWidth: vw, innerHeight: vh } = window;
  const box = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, vw - box.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, vh - box.height - 4))}px`;

  const buttons = () => [...el.querySelectorAll('.context-item:not(:disabled)')];
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const list = buttons();
      const i = list.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    }
  };
  const onPointer = (e) => {
    if (!el.contains(e.target)) closeContextMenu();
  };
  const listeners = [
    [document, 'keydown', onKey, true],
    [document, 'pointerdown', onPointer, true],
    [window, 'blur', closeContextMenu, undefined],
    [window, 'resize', closeContextMenu, undefined],
    [document, 'wheel', closeContextMenu, true],
  ];
  for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
  current = { el, listeners };
  buttons()[0]?.focus();
}
