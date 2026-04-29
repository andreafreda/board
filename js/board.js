// ════════════════════════════════════════════════════════════════════
//   board.js — board sizing, panning, view mode + the sketch canvas
// ════════════════════════════════════════════════════════════════════

import { dom } from './dom.js';
import { state, save, isViewMode, setViewMode, uid } from './state.js';
import {
  strokeStart, strokePoint, broadcastStrokeEnd,
} from './realtime.js';

// ── Sketch canvas drawing context ───────────────────────────────────
const ctx = dom.sketch.getContext('2d');

// ── Size / pan ──────────────────────────────────────────────────────
export function clampPan() {
  const vw = window.innerWidth, vh = window.innerHeight;
  // If the board is smaller than the viewport on an axis, auto-center it
  // (no point panning — the whole board is already visible).
  if (state.boardW <= vw) {
    state.panX = Math.round((vw - state.boardW) / 2);
  } else {
    state.panX = Math.max(vw - state.boardW, Math.min(0, state.panX));
  }
  if (state.boardH <= vh) {
    state.panY = Math.round((vh - state.boardH) / 2);
  } else {
    state.panY = Math.max(vh - state.boardH, Math.min(0, state.panY));
  }
}

export function applyPan() {
  dom.board.style.transform = `translate(${state.panX}px,${state.panY}px)`;
}

let _afterApply = () => {}; // injected by main.js to avoid circular imports
export function setAfterApply(fn) { _afterApply = fn; }

export function applyBoardSize(w, h) {
  state.boardW = w; state.boardH = h;
  dom.board.style.width  = w + 'px';
  dom.board.style.height = h + 'px';

  const dpr = window.devicePixelRatio || 1;
  dom.sketch.width  = Math.round(w * dpr);
  dom.sketch.height = Math.round(h * dpr);
  dom.sketch.style.width  = w + 'px';
  dom.sketch.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Clamp existing notes inside the new size
  state.notes.forEach((n) => {
    n.x = Math.max(4, Math.min(w - n.w - 4, n.x));
    n.y = Math.max(4, Math.min(h - n.h - 4, n.y));
  });

  clampPan();
  applyPan();
  _afterApply();      // → renderNotes() + redrawBoard() (wired in main.js)
}

export function centerBoard() {
  state.panX = Math.round((window.innerWidth  - state.boardW) / 2);
  state.panY = Math.round((window.innerHeight - state.boardH) / 2);
  clampPan(); applyPan(); save();
}

let panTimer = null;
function showPanInd() {
  dom.panInd.textContent = `${-Math.round(state.panX)},${-Math.round(state.panY)}`;
  dom.panInd.classList.add('show');
  clearTimeout(panTimer);
  panTimer = setTimeout(() => dom.panInd.classList.remove('show'), 1200);
}

// ── Pan handlers ────────────────────────────────────────────────────
let panning = false, panStart = null, panOrigin = null;
export function initPan() {
  dom.viewport.addEventListener('pointerdown', (e) => {
    if (state.drawMode || state.textMode) return;
    const t = e.target;
    if (t !== dom.board && t !== dom.sketch && t !== dom.notesLayer) return;
    panning = true;
    panStart  = { x: e.clientX, y: e.clientY };
    panOrigin = { x: state.panX, y: state.panY };
    dom.viewport.setPointerCapture(e.pointerId);
  }, { passive: true });

  dom.viewport.addEventListener('pointermove', (e) => {
    if (!panning) return;
    state.panX = panOrigin.x + (e.clientX - panStart.x);
    state.panY = panOrigin.y + (e.clientY - panStart.y);
    clampPan(); applyPan(); showPanInd();
  }, { passive: true });

  dom.viewport.addEventListener('pointerup', () => {
    if (panning) { panning = false; save(); }
  });

  // Window resize → re-clamp (which may re-center small boards)
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { clampPan(); applyPan(); }, 80);
  });
}

// ── Sketch canvas (board-level drawing) ─────────────────────────────
export function initSketchCanvas() {
  const dpr = window.devicePixelRatio || 1;
  dom.sketch.width  = Math.round(state.boardW * dpr);
  dom.sketch.height = Math.round(state.boardH * dpr);
  dom.sketch.style.width  = state.boardW + 'px';
  dom.sketch.style.height = state.boardH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// In-progress strokes from peers, keyed by strokeId. They live here only
// until their `stroke:end` arrives — at that point we move the finalised
// stroke into state.strokes (with _ownerId tag so save() ignores it).
const _remoteLiveStrokes = new Map();

function _drawStroke(s) {
  if (!s || !s.points || s.points.length < 1) return;
  ctx.globalCompositeOperation = s.eraser ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.eraser ? 'rgba(0,0,0,1)' : (s.color || '#1f2328');
  ctx.lineWidth   = s.size || 7;
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i].x, s.points[i].y);
  }
  if (s.points.length === 1) {
    // A dot — degenerate "line" so it actually paints
    ctx.lineTo(s.points[0].x + 0.01, s.points[0].y + 0.01);
  }
  ctx.stroke();
}

export function redrawBoard() {
  ctx.clearRect(0, 0, state.boardW, state.boardH);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  (state.strokes || []).forEach(_drawStroke);
  // Render any in-progress remote strokes on top
  _remoteLiveStrokes.forEach(_drawStroke);
  ctx.globalCompositeOperation = 'source-over';
}

// ── Remote stroke broadcasts (target='board' only — note canvas is
//    synced via the existing note:upsert flow at pointerup) ──────────
export function applyRemoteStrokePts(payload) {
  if (payload.target !== 'board') return;
  let s = _remoteLiveStrokes.get(payload.strokeId);
  if (!s) {
    s = {
      strokeId: payload.strokeId,
      color: payload.color, size: payload.size, eraser: payload.eraser,
      points: [],
    };
    _remoteLiveStrokes.set(payload.strokeId, s);
  }
  if (Array.isArray(payload.points)) s.points.push(...payload.points);
  redrawBoard();
}

export function applyRemoteStrokeEnd(payload) {
  if (payload.target !== 'board') return;
  _remoteLiveStrokes.delete(payload.strokeId);
  // Commit the finalised stroke into state.strokes with _ownerId tag.
  // Filter at save time keeps it out of OUR strokes row (the originator
  // already wrote it to their own row).
  state.strokes.push({
    strokeId: payload.strokeId,
    color: payload.color, size: payload.size, eraser: payload.eraser,
    points: payload.points || [],
    _ownerId: payload.owner || null,
  });
  redrawBoard();
}

export function clearRemoteLiveStrokes() {
  _remoteLiveStrokes.clear();
}

function sketchPos(e) {
  const r = dom.sketch.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function initSketchHandlers() {
  let drawing = false, boardStroke = null;

  dom.sketch.addEventListener('pointerdown', (e) => {
    if (!state.drawMode) return;
    drawing = true;
    dom.sketch.setPointerCapture(e.pointerId);
    const startPt = sketchPos(e);
    boardStroke = {
      strokeId: uid(),
      points:   [startPt],
      color:    state.penColor,
      size:     state.eraser ? state.eraserSize : state.penSize,
      eraser:   state.eraser,
    };
    state.strokes.push(boardStroke);
    redrawBoard();

    // Realtime: announce stroke start + first point
    strokeStart(boardStroke.strokeId, 'board', boardStroke);
    strokePoint(startPt);
  });

  dom.sketch.addEventListener('pointermove', (e) => {
    if (!drawing || !boardStroke) return;
    const pt = sketchPos(e);
    boardStroke.points.push(pt);
    redrawBoard();
    strokePoint(pt);
  });

  window.addEventListener('pointerup', () => {
    if (!drawing) return;
    drawing = false;
    if (boardStroke) {
      // Final authoritative payload — receivers replace any in-progress
      // copy with this one to guarantee no points were dropped on the way.
      broadcastStrokeEnd(boardStroke.strokeId, 'board', boardStroke.points, boardStroke);
    }
    boardStroke = null;
    save();
  });
}

// ── View mode (read-only shared board) ──────────────────────────────
let _onViewMode = () => {};
export function setOnViewMode(fn) { _onViewMode = fn; }

export function enterViewMode(boardData) {
  setViewMode(true);
  // Replace state with the shared board's data (read-only display)
  state.boardW = boardData.width  || 1366;
  state.boardH = boardData.height || 768;
  state.panX = 0; state.panY = 0;
  state.notes   = boardData.notes   || [];
  state.strokes = boardData.strokes || [];

  applyBoardSize(state.boardW, state.boardH);

  // Reveal the board (was hidden by the pending-view CSS class) and hide editing UI
  document.documentElement.classList.remove('pending-view');
  if (dom.corner) dom.corner.style.cssText = 'display:none!important';
  if (dom.viewBoardName) dom.viewBoardName.textContent = boardData.name || 'Board';
  dom.viewBanner?.classList.add('on');
  document.title = (boardData.name || 'Board') + ' · Board';

  // Make every interactive element non-interactive
  dom.sketch.style.pointerEvents = 'none';
  dom.notesLayer.querySelectorAll('textarea').forEach((t) => {
    t.readOnly = true; t.style.pointerEvents = 'none';
  });
  dom.notesLayer.querySelectorAll('.note-canvas').forEach((nc) => {
    nc.style.pointerEvents = 'none';
  });
  dom.notesLayer.querySelectorAll('.note-head').forEach((h) => {
    h.style.pointerEvents = 'none';
  });
  dom.notesLayer.querySelectorAll('.resize-handle').forEach((r) => {
    r.style.pointerEvents = 'none';
  });

  _onViewMode();
}

export function exitViewMode() {
  setViewMode(false);
  if (dom.corner) dom.corner.style.cssText = '';
  dom.viewBanner?.classList.remove('on');
  dom.sketch.style.pointerEvents = '';
}

export function initViewModeExitButton() {
  dom.viewExitBtn?.addEventListener('click', () => {
    // Strip ?board= and reload as a normal app session
    window.location.href = location.origin + location.pathname;
  });
}
