// ════════════════════════════════════════════════════════════════════
//   cursors.js — live cursor overlay for cooperative peers
// ════════════════════════════════════════════════════════════════════
// One layer is mounted INSIDE the #board element so it rides the same
// pan transform as every other board content (notes, strokes). That
// means we don't have to manually reposition cursors on pan/resize.
//
// Cursor coordinates broadcast by peers are BOARD-local (sent x,y were
// already translated against the sender's pan), so we render them with
// `translate(x, y)` directly — no further math needed.

import { dom } from './dom.js';

const HIDE_AFTER_MS = 3000;

const _cursors = new Map(); // userId → { el, hideTimer }

function makeCursorEl(peer) {
  const el = document.createElement('div');
  el.className = 'peer-cursor on';
  el.dataset.userId = peer.userId;
  el.style.setProperty('--c', peer.color || '#888');
  el.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M3.5 2.2 L21 11 L13 13 L11 21 Z"
            fill="var(--c)" stroke="white" stroke-width="1.5"
            stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <span class="peer-cursor-name"></span>
  `;
  el.querySelector('.peer-cursor-name').textContent = peer.name || 'Anonimo';
  return el;
}

function ensureCursor(peer) {
  let entry = _cursors.get(peer.userId);
  if (entry) {
    // Refresh display info in case colour or name changed since join
    if (peer.color) entry.el.style.setProperty('--c', peer.color);
    if (peer.name)  entry.el.querySelector('.peer-cursor-name').textContent = peer.name;
    return entry;
  }
  const layer = dom.cursorsLayer;
  if (!layer) return null;
  const el = makeCursorEl(peer);
  layer.appendChild(el);
  entry = { el, hideTimer: null };
  _cursors.set(peer.userId, entry);
  return entry;
}

export function applyRemoteCursor({ userId, name, color, x, y }) {
  if (!userId || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const entry = ensureCursor({ userId, name, color });
  if (!entry) return;
  entry.el.style.transform = `translate(${x}px, ${y}px)`;
  entry.el.classList.add('on');
  if (entry.hideTimer) clearTimeout(entry.hideTimer);
  entry.hideTimer = setTimeout(() => {
    entry.el.classList.remove('on');
  }, HIDE_AFTER_MS);
}

// Drop cursors for users who left the channel (called on presence event)
export function reconcileCursors(peers) {
  const ids = new Set((peers || []).map((p) => p.userId));
  _cursors.forEach((entry, userId) => {
    if (ids.has(userId)) return;
    if (entry.hideTimer) clearTimeout(entry.hideTimer);
    entry.el.remove();
    _cursors.delete(userId);
  });
}

export function clearAllCursors() {
  _cursors.forEach((entry) => {
    if (entry.hideTimer) clearTimeout(entry.hideTimer);
    entry.el.remove();
  });
  _cursors.clear();
}
