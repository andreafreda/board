// ════════════════════════════════════════════════════════════════════
//   collab.js — orchestrates the realtime channel lifecycle
// ════════════════════════════════════════════════════════════════════
// Decides whether we should be inside a board's realtime channel based
// on (a) the user being logged in and (b) the active board being
// cooperative. Called whenever any of those change.

import { getClient } from './db.js';
import { state, setReadOnly } from './state.js';
import { joinBoardChannel, leaveBoardChannel, colorForUser } from './realtime.js';
import { renderPeers, clearPeers } from './peers.js';

// Apply / clear the cooperative-viewer UI lockout based on the active board's
// myRole. Idempotent. Called from syncCollabChannel which is invoked on every
// active-board change.
function applyRoleUI(board) {
  const isViewer = !!(board && board.myRole === 'viewer');
  setReadOnly(isViewer);
  document.body.classList.toggle('coop-viewer', isViewer);
}

// auth.js wires this so we can read the current user without circular imports
let _getCurrentUser = () => null;
export function setUserGetter(fn) { _getCurrentUser = fn; }

let _busy = false;

export async function syncCollabChannel() {
  // Cheap re-entrancy guard — switchBoard can fire a few times in quick
  // succession during onAuthStateChange + bootstrap; we don't want
  // overlapping subscribe/unsubscribe calls.
  if (_busy) return;
  _busy = true;
  try {
    const u = _getCurrentUser();
    const b = state.boards.find((bd) => bd.id === state.activeBoardId);

    // Apply read-only UI lockout regardless of channel state
    applyRoleUI(b);

    if (!u || !b || b.visibility !== 'cooperative') {
      await leaveBoardChannel();
      clearPeers();
      return;
    }

    const client = await getClient();
    const meta = u.user_metadata || {};
    const me = {
      userId: u.id,
      name:   meta.full_name || meta.name || u.email?.split('@')[0] || '?',
      avatar: meta.avatar_url || meta.picture || '',
      role:   b.myRole || 'viewer',
      color:  colorForUser(u.id),
    };

    await joinBoardChannel(client, b.id, me, (event) => {
      if (event.type === 'presence') renderPeers(event.peers);
      // Other event types (note:*, stroke:*, cursor) wired in steps 2.2–2.4
    });
  } finally {
    _busy = false;
  }
}

export async function leaveCollab() {
  await leaveBoardChannel();
  clearPeers();
  // Drop any read-only UI lockout when stepping out of all collab
  setReadOnly(false);
  document.body.classList.remove('coop-viewer');
}
