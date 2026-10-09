// Small popup menu. showContextMenu(x, y, items) where each item is
//   { label, shortcut?, action, disabled?, danger?, checked? },
//   { heading: 'Section title' }, or '-' for a separator.
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
  // Drop missing items and any separator that would be doubled, leading or trailing.
  const entries = items
    .filter(Boolean)
    .filter((item, i, list) => item !== '-' || (i > 0 && i < list.length - 1 && list[i + 1] !== '-'));
  const el = h('div.context-menu', { role: 'menu' },
    ...entries.map((item) => {
      if (item === '-') return h('div.context-sep', { role: 'separator' });
      if (item.heading) return h('div.context-heading', {}, item.heading);
      const checkable = item.checked !== undefined;
      return h(`button.context-item${item.danger ? '.danger' : ''}${item.checked ? '.checked' : ''}`, {
        role: checkable ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': checkable ? String(item.checked) : undefined,
        disabled: Boolean(item.disabled),
        onclick: () => {
          closeContextMenu();
          item.action();
        },
      },
        h('span.context-label', {}, checkable ? h('span.context-check', {}, item.checked ? '✓' : '') : null, item.label),
        item.shortcut ? h('span.context-shortcut', {}, item.shortcut) : null);
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
