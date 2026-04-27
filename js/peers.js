// ════════════════════════════════════════════════════════════════════
//   peers.js — avatar stack of who's online on the current board
// ════════════════════════════════════════════════════════════════════
// Mobile-first compact pill: top-center fixed, between the clock and
// the corner buttons. Shows up to MAX_VISIBLE avatars (overflow as +N),
// with role badge per avatar and a counts label on the right.

import { dom } from './dom.js';

const MAX_VISIBLE = 5;
const ROLE_ICON = { owner: '🔑', editor: '✏️', viewer: '👁' };

function makeAvatar(peer) {
  const el = document.createElement('div');
  el.className = 'peer-avatar' + (peer.role === 'viewer' ? ' viewer' : '');
  el.style.background = peer.color;
  el.title = `${peer.name || 'Anonimo'} · ${peer.role || 'viewer'}`;

  if (peer.avatar) {
    const img = document.createElement('img');
    img.src = peer.avatar;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = (peer.name || '?').charAt(0).toUpperCase();
  }

  // Role badge (small icon at bottom-right)
  const badge = document.createElement('span');
  badge.className = 'peer-role';
  badge.textContent = ROLE_ICON[peer.role] || '?';
  el.appendChild(badge);

  return el;
}

function makeOverflow(n) {
  const el = document.createElement('div');
  el.className = 'peer-avatar peer-overflow';
  el.textContent = '+' + n;
  el.title = `${n} altri`;
  return el;
}

function makeCounts(peers) {
  const counts = { owner: 0, editor: 0, viewer: 0 };
  peers.forEach((p) => { counts[p.role || 'viewer']++; });
  const parts = [];
  if (counts.owner)  parts.push(`${ROLE_ICON.owner} ${counts.owner}`);
  if (counts.editor) parts.push(`${ROLE_ICON.editor} ${counts.editor}`);
  if (counts.viewer) parts.push(`${ROLE_ICON.viewer} ${counts.viewer}`);
  if (!parts.length) return null;
  const el = document.createElement('span');
  el.className = 'peers-counts';
  el.textContent = parts.join(' · ');
  return el;
}

export function renderPeers(peers) {
  const stack = dom.peersStack;
  if (!stack) return;
  stack.innerHTML = '';
  if (!peers || !peers.length) {
    stack.classList.remove('on');
    return;
  }
  stack.classList.add('on');

  const visible  = peers.slice(0, MAX_VISIBLE);
  const overflow = peers.length - visible.length;

  visible.forEach((p) => stack.appendChild(makeAvatar(p)));
  if (overflow > 0) stack.appendChild(makeOverflow(overflow));

  const counts = makeCounts(peers);
  if (counts) stack.appendChild(counts);
}

export function clearPeers() {
  if (dom.peersStack) {
    dom.peersStack.innerHTML = '';
    dom.peersStack.classList.remove('on');
  }
}
