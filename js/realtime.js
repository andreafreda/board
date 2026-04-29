// ════════════════════════════════════════════════════════════════════
//   realtime.js — Supabase Realtime per cooperative boards
// ════════════════════════════════════════════════════════════════════
// One channel per board (`board:<uuid>`), opened when the user enters a
// cooperative board they're a member of, closed when leaving.
//
// Currently in this commit (2.1): Presence only — the avatar stack
// shows who's online with their role.
//
// Later commits will add Broadcast events for note/stroke/cursor sync
// (note:upsert/delete, stroke:pt/end, cursor). The skeleton is here so
// each step is a small additive change.

// ── Tunables (performance-first knobs — adjust if traffic gets heavy) ─
export const TRAFFIC = {
  // How often a peer broadcasts cursor updates (ms between sends)
  cursorThrottleMs: 50,
  // Stroke point batch interval — collect points for this many ms then send
  strokeBatchMs: 33,
  // Note drag broadcast throttle
  noteDragThrottleMs: 50,
  // Note text input debounce
  noteTextDebounceMs: 200,
};
export function setTrafficConfig(partial) { Object.assign(TRAFFIC, partial); }

// ── Stable color for a user id (for presence avatars / cursors) ─────
const PRESENCE_COLORS = [
  '#E14B5C', '#F08C2D', '#F0BB22', '#41C467', '#23B8B8',
  '#3677F0', '#7E47E8', '#C24DD8', '#E84B8C', '#566677',
];
export function colorForUser(userId) {
  let h = 0;
  const s = String(userId || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length];
}

// ── Internal channel state ──────────────────────────────────────────
let _channel = null;
let _currentBoardId = null;
let _meId = null;
let _onEvent = () => {};

/**
 * Join the realtime channel for a given board.
 * @param client     supabase-js client
 * @param boardId    uuid of the board
 * @param me         {userId, name, avatar, role} — local user for Presence track
 * @param onEvent    callback for incoming events:
 *                   { type: 'presence', peers: [{...}, ...] }
 *                   (more event types come in commits 2.2-2.5)
 */
export async function joinBoardChannel(client, boardId, me, onEvent) {
  if (_currentBoardId === boardId && _channel) return; // idempotent
  await leaveBoardChannel();

  _currentBoardId = boardId;
  _meId = me.userId;
  _onEvent = onEvent || (() => {});

  _channel = client.channel(`board:${boardId}`, {
    config: {
      presence: { key: me.userId },
      broadcast: { self: false }, // never echo our own messages back
    },
  });

  // ── Presence ───────────────────────────────────────────────────────
  const emitPresence = () => {
    if (!_channel) return;
    const state = _channel.presenceState();
    // Flatten: { userId: [{...trackData}] } → array, dedup self
    const peers = [];
    for (const id in state) {
      if (id === _meId) continue;
      const arr = state[id];
      if (arr && arr[0]) peers.push({ userId: id, ...arr[0] });
    }
    _onEvent({ type: 'presence', peers });
  };
  _channel.on('presence', { event: 'sync' },  emitPresence);
  _channel.on('presence', { event: 'join' },  emitPresence);
  _channel.on('presence', { event: 'leave' }, emitPresence);

  // ── Broadcast: notes (commit 2.2) ─────────────────────────────────
  _channel.on('broadcast', { event: 'note:upsert' }, ({ payload }) => {
    if (!payload) return;
    _onEvent({ type: 'note:upsert', note: payload });
  });
  _channel.on('broadcast', { event: 'note:delete' }, ({ payload }) => {
    if (!payload) return;
    _onEvent({ type: 'note:delete', id: payload.id });
  });

  await _channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await _channel.track({
        name:   me.name   || '',
        avatar: me.avatar || '',
        color:  me.color  || colorForUser(me.userId),
        role:   me.role   || 'viewer',
        joined_at: Date.now(),
      });
    }
  });
}

export async function leaveBoardChannel() {
  clearPendingBroadcasts();
  if (!_channel) return;
  try {
    await _channel.untrack();
    await _channel.unsubscribe();
  } catch {}
  _channel = null;
  _currentBoardId = null;
  _meId = null;
  _onEvent = () => {};
}

export function getCurrentBoardChannelId() { return _currentBoardId; }
export function getChannel() { return _channel; }

// ── Broadcast helpers ────────────────────────────────────────────────
// Note: peers strip our private `_ownerId` tag from payloads — they don't
// need to know who originally created a row, only who's broadcasting now.

function stripPrivate(o) {
  if (!o || typeof o !== 'object') return o;
  const { _ownerId, ...rest } = o;
  return rest;
}

export function broadcastNoteUpsert(note) {
  if (!_channel || !note?.id) return;
  _channel.send({ type: 'broadcast', event: 'note:upsert', payload: stripPrivate(note) });
}

export function broadcastNoteDelete(id) {
  if (!_channel || !id) return;
  _channel.send({ type: 'broadcast', event: 'note:delete', payload: { id } });
}

// Per-note pending broadcast queue.
//   throttled: trailing-edge — first call schedules a send in `ms`, subsequent
//              calls within the window just refresh the data, no new timer.
//   debounced: leading + trailing reset — every call resets the timer, send
//              only fires after `ms` of silence (good for typing).
const _pendingNoteBcasts = new Map(); // id → { note, timer, kind }

function _schedule(note, kind, ms) {
  if (!_channel || !note?.id) return;
  const id = note.id;
  const existing = _pendingNoteBcasts.get(id);
  if (kind === 'throttle') {
    if (existing) {
      // Just refresh data; let the existing timer fire as scheduled
      existing.note = note;
      return;
    }
  } else { // debounce
    if (existing) clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    const p = _pendingNoteBcasts.get(id);
    _pendingNoteBcasts.delete(id);
    if (p) broadcastNoteUpsert(p.note);
  }, ms);
  _pendingNoteBcasts.set(id, { note, timer, kind });
}

export const scheduleNoteUpsertThrottled = (note) =>
  _schedule(note, 'throttle', TRAFFIC.noteDragThrottleMs);
export const scheduleNoteUpsertDebounced = (note) =>
  _schedule(note, 'debounce', TRAFFIC.noteTextDebounceMs);

export function flushPendingNote(id) {
  const existing = _pendingNoteBcasts.get(id);
  if (!existing) return;
  clearTimeout(existing.timer);
  _pendingNoteBcasts.delete(id);
  broadcastNoteUpsert(existing.note);
}

function clearPendingBroadcasts() {
  _pendingNoteBcasts.forEach((p) => clearTimeout(p.timer));
  _pendingNoteBcasts.clear();
}

// (Stubs for upcoming commits)
export function broadcastStrokePts(_payload) { /* TODO 2.3 */ }
export function broadcastStrokeEnd(_payload) { /* TODO 2.3 */ }
export function broadcastCursor(_x, _y)      { /* TODO 2.4 */ }
