// ════════════════════════════════════════════════════════════════════
//   notes.js — post-it rendering, drag/resize, per-note canvas
// ════════════════════════════════════════════════════════════════════

import { dom } from './dom.js';
import { state, save, uid, clone, NOTE_COLOR_MAP } from './state.js';
import {
  broadcastNoteUpsert, broadcastNoteDelete,
  scheduleNoteUpsertThrottled, scheduleNoteUpsertDebounced,
  flushPendingNote,
} from './realtime.js';

// Set to true while applying an inbound peer broadcast — guard handlers from
// re-broadcasting and triggering an echo loop. (Programmatic style/value
// changes don't fire pointer/input events, so we mainly need this for the
// .value = ... case; defensive elsewhere.)
let _applyingRemote = false;
export const isApplyingRemote = () => _applyingRemote;

// ── Active note (text-mode editing target) ──────────────────────────
let activeNote = null;
export const getActiveNote = () => activeNote;

let _onNoteToolbar = () => {}; // wired by main.js → modes.renderTextToolbar
export function setOnNoteToolbar(fn) { _onNoteToolbar = fn; }

let _onTextToolbarHidden = () => {};
export function setOnTextToolbarHidden(fn) { _onTextToolbarHidden = fn; }

let _showConfirm = () => {};
export function setShowConfirm(fn) { _showConfirm = fn; }

export function activateNote(note, el) {
  deactivateNote();
  activeNote = { note, el };
  el.classList.add('text-active');
  const ta = el.querySelector('textarea');
  ta.classList.add('editable');
  ta.readOnly = false;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  _onNoteToolbar(note);
}

export function deactivateNote() {
  if (activeNote) {
    activeNote.el.classList.remove('text-active');
    const ta = activeNote.el.querySelector('textarea');
    ta.classList.remove('editable');
    ta.readOnly = true;
    save();
  }
  activeNote = null;
  _onTextToolbarHidden();
}

// ── Canvas-on-note drawing ──────────────────────────────────────────
function resizeNoteCanvas(nc, note) {
  const dpr = window.devicePixelRatio || 1;
  const ch  = note.h - 34; // subtract head bar height
  nc.width  = Math.round(note.w * dpr);
  nc.height = Math.round(ch     * dpr);
  nc.style.width  = note.w + 'px';
  nc.style.height = ch     + 'px';
  const c = nc.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawNoteCanvas(nc, note);
}

function redrawNoteCanvas(nc, note) {
  const c = nc.getContext('2d');
  c.clearRect(0, 0, note.w, note.h);
  c.lineCap = 'round'; c.lineJoin = 'round';
  (note.noteStrokes || []).forEach((s) => {
    if (!s.points || s.points.length < 2) return;
    c.globalCompositeOperation = s.eraser ? 'destination-out' : 'source-over';
    c.strokeStyle = s.eraser ? 'rgba(0,0,0,1)' : (s.color || '#1f2328');
    c.lineWidth   = s.size || 7;
    c.beginPath();
    c.moveTo(s.points[0].x, s.points[0].y);
    s.points.slice(1).forEach((p) => c.lineTo(p.x, p.y));
    c.stroke();
  });
  c.globalCompositeOperation = 'source-over';
}

// ── Single-note DOM builder ─────────────────────────────────────────
let drag = null, resizing = null;

function makeNote(note) {
  // Defaults for older saved data
  if (!note.w) note.w = 210;
  if (!note.h) note.h = 180;
  if (!note.textColor) note.textColor = '#1f2328';
  if (!note.fontSize)  note.fontSize  = 15;
  if (!note.noteStrokes) note.noteStrokes = [];

  const el = document.createElement('article');
  el.className = 'note';
  el.dataset.id = note.id;
  el.style.cssText = `left:${note.x}px;top:${note.y}px;width:${note.w}px;height:${note.h}px;`;
  el.style.setProperty('--rot', (note.rot || 0) + 'deg');
  el.style.background = NOTE_COLOR_MAP[note.color] || NOTE_COLOR_MAP.yellow;
  el.innerHTML = `
    <div class="note-head">
      <button class="mini-btn" data-action="dup" tabindex="-1" type="button">＋</button>
      <button class="mini-btn" data-action="del" tabindex="-1" type="button">×</button>
    </div>
    <textarea spellcheck="false" readonly></textarea>
    <canvas class="note-canvas"></canvas>
    <div class="resize-handle" data-resize></div>
  `;

  const ta = el.querySelector('textarea');
  const nc = el.querySelector('canvas.note-canvas');
  ta.value = note.text;
  ta.style.color    = note.textColor;
  ta.style.fontSize = note.fontSize + 'px';
  ta.addEventListener('input', () => {
    if (_applyingRemote) return;
    note.text = ta.value;
    note.updatedAt = Date.now();
    save();
    scheduleNoteUpsertDebounced(note);
  });

  // Click body in text-mode → activate
  el.addEventListener('click', (e) => {
    if (!state.textMode) return;
    if (
      e.target.closest('[data-action]') ||
      e.target.closest('[data-resize]') ||
      e.target.closest('.note-canvas')  ||
      e.target.closest('.note-head')
    ) return;
    activateNote(note, el);
  });

  // Delete / Duplicate buttons
  el.querySelector('[data-action="del"]').addEventListener('click', (e) => {
    e.stopPropagation();
    _showConfirm(e.currentTarget, () => {
      state.notes = state.notes.filter((n) => n.id !== note.id);
      if (activeNote && activeNote.note.id === note.id) deactivateNote();
      renderNotes();
      save();
      broadcastNoteDelete(note.id);
    });
  });
  el.querySelector('[data-action="dup"]').addEventListener('click', (e) => {
    e.stopPropagation();
    const dup = {
      ...clone(note),
      id: uid(),
      x: Math.min(state.boardW - note.w - 4, note.x + 20),
      y: Math.min(state.boardH - note.h - 4, note.y + 20),
      noteStrokes: clone(note.noteStrokes || []),
      updatedAt: Date.now(),
    };
    state.notes.push(dup);
    renderNotes();
    save();
    broadcastNoteUpsert(dup);
  });

  // Drag from the head
  const head = el.querySelector('.note-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-action]')) return;
    drag = {
      id: note.id,
      ox: e.clientX - note.x - state.panX,
      oy: e.clientY - note.y - state.panY,
    };
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  el.addEventListener('pointermove', (e) => {
    if (drag && drag.id === note.id) {
      note.x = Math.max(4, Math.min(state.boardW - note.w - 4, e.clientX - state.panX - drag.ox));
      note.y = Math.max(4, Math.min(state.boardH - note.h - 4, e.clientY - state.panY - drag.oy));
      el.style.left = note.x + 'px';
      el.style.top  = note.y + 'px';
      scheduleNoteUpsertThrottled(note);
    }
    if (resizing && resizing.id === note.id) {
      note.w = Math.max(120, Math.min(state.boardW - note.x - 4, resizing.sw + (e.clientX - resizing.sx)));
      note.h = Math.max(100, Math.min(state.boardH - note.y - 4, resizing.sh + (e.clientY - resizing.sy)));
      el.style.width  = note.w + 'px';
      el.style.height = note.h + 'px';
      resizeNoteCanvas(nc, note);
      scheduleNoteUpsertThrottled(note);
    }
  });
  el.addEventListener('pointerup', () => {
    if (drag && drag.id === note.id)         { drag = null;     el.classList.remove('dragging'); save(); flushPendingNote(note.id); broadcastNoteUpsert(note); }
    if (resizing && resizing.id === note.id) { resizing = null; save(); flushPendingNote(note.id); broadcastNoteUpsert(note); }
  });

  // Resize handle (SE corner)
  const rh = el.querySelector('[data-resize]');
  rh.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    resizing = { id: note.id, sx: e.clientX, sy: e.clientY, sw: note.w, sh: note.h };
    el.setPointerCapture(e.pointerId);
  });
  rh.addEventListener('click', (e) => e.stopPropagation());

  // Per-note canvas drawing
  resizeNoteCanvas(nc, note);
  let nd = false, ns = null;
  const np = (e) => {
    const r = nc.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  nc.addEventListener('pointerdown', (e) => {
    if (!state.drawMode) return;
    nd = true;
    nc.setPointerCapture(e.pointerId);
    ns = {
      points: [np(e)],
      color:  state.penColor,
      size:   state.eraser ? state.eraserSize : state.penSize,
      eraser: state.eraser,
    };
    note.noteStrokes.push(ns);
    redrawNoteCanvas(nc, note);
    e.stopPropagation();
  });
  nc.addEventListener('pointermove', (e) => {
    if (!nd || !ns) return;
    ns.points.push(np(e));
    redrawNoteCanvas(nc, note);
  });
  nc.addEventListener('pointerup',     () => { if (nd) { nd = false; ns = null; save(); } });
  nc.addEventListener('pointercancel', () => { nd = false; ns = null; });

  if (state.drawMode && !state.eraser) nc.classList.add('draw-on');
  if (state.drawMode &&  state.eraser) nc.classList.add('eraser-on');

  return el;
}

// ── Render all notes ────────────────────────────────────────────────
export function renderNotes() {
  dom.notesLayer.innerHTML = '';
  state.notes.forEach((n) => dom.notesLayer.appendChild(makeNote(n)));
}

// ════════════════════════════════════════════════════════════════════
//   Remote broadcasts → local state + DOM (no save, no re-broadcast)
// ════════════════════════════════════════════════════════════════════
// In-place DOM update for a known note id — avoids destroying the article
// element and triggering a full notesLayer rebuild on every peer event.
function updateNoteDom(note) {
  const el = dom.notesLayer.querySelector(`.note[data-id="${note.id}"]`);
  if (!el) { renderNotes(); return; }

  el.style.left   = note.x + 'px';
  el.style.top    = note.y + 'px';
  el.style.width  = note.w + 'px';
  el.style.height = note.h + 'px';
  el.style.setProperty('--rot', (note.rot || 0) + 'deg');
  el.style.background = NOTE_COLOR_MAP[note.color] || NOTE_COLOR_MAP.yellow;

  const ta = el.querySelector('textarea');
  if (ta) {
    // Don't trample text the user is currently typing
    if (document.activeElement !== ta && ta.value !== note.text) {
      ta.value = note.text || '';
    }
    ta.style.color    = note.textColor || '#1f2328';
    ta.style.fontSize = (note.fontSize || 15) + 'px';
  }

  // Resize the per-note canvas + redraw (covers live stroke updates from 2.3)
  const nc = el.querySelector('canvas.note-canvas');
  if (nc) resizeNoteCanvas(nc, note);
}

export function applyRemoteNoteUpsert(noteData) {
  if (!noteData || !noteData.id) return;
  _applyingRemote = true;
  try {
    const idx = state.notes.findIndex((n) => n.id === noteData.id);
    if (idx >= 0) {
      const existing = state.notes[idx];
      // Preserve our local _ownerId tag — the broadcaster doesn't include it
      const ownerTag = existing._ownerId;
      Object.assign(existing, noteData);
      if (ownerTag !== undefined) existing._ownerId = ownerTag;
      updateNoteDom(existing);
    } else {
      // New note from a peer — append + full re-render so all event
      // handlers wire correctly via makeNote().
      state.notes.push({ ...noteData });
      renderNotes();
    }
  } finally { _applyingRemote = false; }
}

export function applyRemoteNoteDelete(id) {
  if (!id) return;
  _applyingRemote = true;
  try {
    const idx = state.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    state.notes.splice(idx, 1);
    if (activeNote && activeNote.note.id === id) {
      // Drop the dangling reference and hide the text toolbar
      activeNote = null;
      _onTextToolbarHidden();
    }
    const el = dom.notesLayer.querySelector(`.note[data-id="${id}"]`);
    if (el) el.remove();
  } finally { _applyingRemote = false; }
}

// ── Add a new note centred in the current viewport ─────────────────
export function addCenteredNote() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = Math.round(-state.panX + (vw / 2) - 105);
  const cy = Math.round(-state.panY + (vh / 2) - 90);
  const note = {
    id: uid(), text: '', color: state.noteColor,
    x: Math.max(4, Math.min(state.boardW - 214, cx)),
    y: Math.max(4, Math.min(state.boardH - 184, cy)),
    w: 210, h: 180,
    rot: +(Math.random() * 4 - 2).toFixed(1),
    textColor: '#1f2328', fontSize: 15,
    noteStrokes: [],
    updatedAt: Date.now(),
  };
  state.notes.push(note);
  renderNotes();
  save();
  broadcastNoteUpsert(note);
}
