// ════════════════════════════════════════════════════════════════════
//   status.js — connection / save-state badge
// ════════════════════════════════════════════════════════════════════
// A small pill in the corner that reflects the cloud sync state for a
// logged-in user:
//   ● Saved    — connected, idle, all writes flushed
//   ◌ Saving…  — at least one in-flight save
//   ○ Offline  — navigator.online is false (or channel error)
//
// Hidden entirely when not logged in (guests have nothing to sync).

import { dom } from './dom.js';

let _logged       = false;
let _online       = typeof navigator !== 'undefined' ? !!navigator.onLine : true;
let _savingCount  = 0;
let _channelDown  = false;
let _savedFlashTimer = null;

function render() {
  const el = dom.statusBadge;
  if (!el) return;

  if (!_logged) {
    el.className = 'status-badge';
    el.textContent = '';
    return;
  }

  const offline = !_online || _channelDown;
  let cls, text;
  if (offline) {
    cls = 'offline'; text = '○ Offline';
  } else if (_savingCount > 0) {
    cls = 'saving';  text = '◌ Saving…';
  } else {
    cls = 'saved';   text = '● Saved';
  }
  el.className = 'status-badge on ' + cls;
  el.textContent = text;
}

export function statusInit() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online',  () => { _online = true;  render(); });
  window.addEventListener('offline', () => { _online = false; render(); });
  render();
}

export function setLoggedIn(b) { _logged = !!b; render(); }

export function beginSave() {
  _savingCount++;
  if (_savedFlashTimer) { clearTimeout(_savedFlashTimer); _savedFlashTimer = null; }
  render();
}
export function endSave() {
  _savingCount = Math.max(0, _savingCount - 1);
  // Brief visual confirmation: we already render Saved when count hits 0.
  // No extra flash needed; the green pill IS the confirmation.
  render();
}

// Channel hooks (called by realtime.js subscribe callback)
export function setChannelConnected(connected) {
  _channelDown = !connected;
  render();
}
