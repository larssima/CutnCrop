/** URL for a local file served by the main process's media:// protocol. */
export function mediaUrl(filePath) {
  return `media://file/${encodeURIComponent(filePath)}`;
}

/** Tiny DOM helper: h('div.clip.selected', { style: {...}, onclick }, children...) */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'color'].includes(el.type)) || el.tagName === 'SELECT' || el.isContentEditable);
}

let toastTimer = null;
export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), ms);
}
