// ════════════════════════════════════════════════════════════════════
//   modes.js — draw / text / note mode toggles + their toolbars
// ════════════════════════════════════════════════════════════════════
// Three mutually exclusive modes are surfaced as corner buttons; each
// brings up a bottom toolbar with mode-specific controls. The clock
// toggle lives here too because the clockToggleBtn is in the drawer.

import { dom } from './dom.js';
import {
  state, save, fmtTime, fmtDate,
  PEN_COLORS, NOTE_COLORS, NOTE_COLOR_MAP, TEXT_COLORS,
  PEN_MIN, PEN_MAX, ERASER_MIN, ERASER_MAX, FONT_MIN, FONT_MAX,
} from './state.js';
import { makeVSlider } from './sliders.js';
import {
  scheduleNoteUpsertThrottled, broadcastNoteUpsert, flushPendingNote,
} from './realtime.js';
import {
  getActiveNote, deactivateNote,
  setOnNoteToolbar, setOnTextToolbarHidden,
  addCenteredNote,
} from './notes.js';

// ── Clock ───────────────────────────────────────────────────────────
export function updateClock() {
  dom.timeLine.textContent = fmtTime();
  dom.dateLine.textContent = fmtDate();
  dom.clockEl.classList.toggle('hidden', !state.showClock);
  // Reflect on body so the board-name pill can shift below the clock.
  document.body.classList.toggle('has-clock', !!state.showClock);
}

export function initClock() {
  setInterval(() => { if (state.showClock) updateClock(); }, 30_000);
  updateClock();
  dom.clockToggleBtn.addEventListener('click', () => {
    state.showClock = !state.showClock;
    dom.clockToggleBtn.style.opacity = state.showClock ? '1' : '.45';
    updateClock(); save();
  });
  // Initial opacity reflects the saved pref
  setTimeout(() => {
    dom.clockToggleBtn.style.opacity = (state.showClock !== false) ? '1' : '.45';
  }, 0);
}

// ── Slider renderers (kept so other mode actions can refresh them) ──
let renderDrawSlider = null;
let renderTxtSlider  = null;

export function initDrawSlider() {
  renderDrawSlider = makeVSlider({
    trackEl: dom.drawSliderTrack,
    fillEl:  dom.drawSliderFill,
    thumbEl: dom.drawSliderThumb,
    valEl:   dom.drawSliderVal,
    min: state.eraser ? ERASER_MIN : PEN_MIN,
    max: state.eraser ? ERASER_MAX : PEN_MAX,
    getValue: () => state.eraser ? state.eraserSize : state.penSize,
    setValue: (v) => { if (state.eraser) state.eraserSize = v; else state.penSize = v; },
    onUpdate: updateDrawPreview,
  });
}

function updateDrawPreview() {
  const sz = state.eraser ? state.eraserSize : state.penSize;
  const d  = Math.min(sz, 28);
  dom.drawSliderPreview.innerHTML =
    `<div style="width:${d}px;height:${d}px;border-radius:999px;
      background:${state.eraser ? 'var(--muted)' : state.penColor};opacity:.85;"></div>`;
}

export function initTxtSlider() {
  renderTxtSlider = makeVSlider({
    trackEl: dom.txtSliderTrack,
    fillEl:  dom.txtSliderFill,
    thumbEl: dom.txtSliderThumb,
    valEl:   dom.txtSliderVal,
    min: FONT_MIN, max: FONT_MAX,
    getValue: () => getActiveNote() ? getActiveNote().note.fontSize : 15,
    setValue: (v) => {
      const an = getActiveNote();
      if (!an) return;
      an.note.fontSize = v;
      an.el.querySelector('textarea').style.fontSize = v + 'px';
      scheduleNoteUpsertThrottled(an.note);
    },
    onUpdate: () => {
      const sz = getActiveNote() ? getActiveNote().note.fontSize : 15;
      dom.txtSliderPreview.style.fontSize = Math.min(sz, 22) + 'px';
    },
  });
}

// Force-close every editing mode (draw / text / note). Used when the user
// transitions into a read-only context (cooperative viewer or view mode) so
// any active toolbar / tool gets dismissed instead of lingering on screen.
export function exitAllModes() {
  state.drawMode = false;
  state.textMode = false;
  state.noteMode = false;
  dom.drawModeBtn?.classList.remove('on');
  dom.textModeBtn?.classList.remove('on');
  dom.noteModeBtn?.classList.remove('on');
  dom.noteToolbar?.classList.remove('visible');
  dom.textToolbar?.classList.remove('visible');
  dom.drawToolbar?.classList.remove('visible');
  // Close any text-edit context on a note as well
  try { deactivateNote(); } catch {}
  syncDraw();
}

// ── Sketch class toggling (called when entering/leaving draw mode) ──
function syncDraw() {
  dom.drawToolbar.classList.toggle('visible', state.drawMode);
  if (state.drawMode) dom.textToolbar.classList.remove('visible');
  dom.sketch.classList.toggle('on',        state.drawMode && !state.eraser);
  dom.sketch.classList.toggle('eraser-on', state.drawMode &&  state.eraser);
  dom.notesLayer.querySelectorAll('.note-canvas').forEach((nc) => {
    nc.classList.toggle('draw-on',   state.drawMode && !state.eraser);
    nc.classList.toggle('eraser-on', state.drawMode &&  state.eraser);
  });
  renderDrawToolbar();
}

function renderDrawToolbar() {
  dom.penBtn.classList.toggle('active', !state.eraser);
  dom.eraserBtn.classList.toggle('active', state.eraser);
  const isPen = !state.eraser;
  dom.penColors.innerHTML = '';
  dom.penColors.style.display = isPen ? 'flex' : 'none';
  dom.drawSep2.style.display  = isPen ? 'block' : 'none';

  PEN_COLORS.forEach((col) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-dot' + (state.penColor === col ? ' active' : '');
    b.style.cssText = `background:${col};width:22px;height:22px;`;
    if (col === '#ffffff') b.style.boxShadow = '0 0 0 1px #aaa';
    b.addEventListener('click', () => {
      state.penColor = col;
      state.eraser = false;
      renderDrawToolbar();
      updateDrawPreview();
      save();
    });
    dom.penColors.appendChild(b);
  });

  if (renderDrawSlider) renderDrawSlider();
  updateDrawPreview();
}

// ── Note toolbar ────────────────────────────────────────────────────
function renderNoteToolbar() {
  dom.noteColors.innerHTML = '';
  NOTE_COLORS.forEach((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-dot' + (state.noteColor === name ? ' active' : '');
    b.style.cssText = `background:${NOTE_COLOR_MAP[name]};width:26px;height:26px;`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.noteColor = name;
      renderNoteToolbar();
      save();
    });
    dom.noteColors.appendChild(b);
  });
}

// ── Text toolbar (called by notes.js when a note is activated) ──────
function renderTextToolbar(note) {
  dom.txtColors.innerHTML = '';
  TEXT_COLORS.forEach((col) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-dot' + (note.textColor === col ? ' active' : '');
    b.style.cssText = `background:${col};width:22px;height:22px;`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      note.textColor = col;
      const an = getActiveNote();
      if (an && an.note.id === note.id) {
        an.el.querySelector('textarea').style.color = col;
      }
      renderTextToolbar(note); save();
      broadcastNoteUpsert(note);
    });
    dom.txtColors.appendChild(b);
  });
  dom.textToolbar.classList.add('visible');
  if (renderTxtSlider) renderTxtSlider();
}

// ── Mode buttons ────────────────────────────────────────────────────
let _openDrawer = () => {};
export function setDrawerToggle(fn) { _openDrawer = fn; }

export function initModes() {
  // Wire notes-side hooks
  setOnNoteToolbar(renderTextToolbar);
  setOnTextToolbarHidden(() => dom.textToolbar.classList.remove('visible'));

  // ── Cursor mode (v2.0): explicit "no mode" button — exits all modes
  // and visually marks itself active when nothing else is on. ──
  const cursorBtn = document.getElementById('cursorModeBtn');
  if (cursorBtn) {
    const syncCursor = () => {
      const idle = !state.drawMode && !state.textMode && !state.noteMode;
      cursorBtn.classList.toggle('on', idle);
    };
    cursorBtn.addEventListener('click', () => { exitAllModes(); save(); syncCursor(); });
    // Re-sync the cursor highlight whenever any mode button is toggled.
    ['drawModeBtn','textModeBtn','noteModeBtn'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => setTimeout(syncCursor, 0));
    });
    syncCursor();
  }

  // ── Draw mode ──
  dom.drawModeBtn.addEventListener('click', () => {
    state.drawMode = !state.drawMode;
    if (state.drawMode) {
      state.textMode = false;
      dom.textModeBtn.classList.remove('on');
      deactivateNote();
      state.noteMode = false;
      dom.noteModeBtn.classList.remove('on');
      dom.noteToolbar.classList.remove('visible');
    }
    dom.drawModeBtn.classList.toggle('on', state.drawMode);
    syncDraw(); save();
  });

  dom.penBtn.addEventListener('click', () => {
    state.eraser = false;
    initDrawSlider();
    renderDrawToolbar();
    save();
  });
  dom.eraserBtn.addEventListener('click', () => {
    state.eraser = true;
    initDrawSlider();
    renderDrawToolbar();
    save();
  });

  // ── Note mode ──
  dom.noteModeBtn.addEventListener('click', () => {
    state.noteMode = !state.noteMode;
    if (state.noteMode) {
      state.drawMode = false;
      dom.drawModeBtn.classList.remove('on');
      syncDraw();
      state.textMode = false;
      dom.textModeBtn.classList.remove('on');
      deactivateNote();
    }
    dom.noteModeBtn.classList.toggle('on', state.noteMode);
    dom.noteToolbar.classList.toggle('visible', state.noteMode);
    if (state.noteMode) renderNoteToolbar();
    _openDrawer(false);
  });

  dom.addNoteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addCenteredNote();
  });

  // ── Text mode ──
  dom.textModeBtn.addEventListener('click', () => {
    state.textMode = !state.textMode;
    if (state.textMode) {
      state.drawMode = false;
      dom.drawModeBtn.classList.remove('on');
      syncDraw();
      state.noteMode = false;
      dom.noteModeBtn.classList.remove('on');
      dom.noteToolbar.classList.remove('visible');
    } else {
      deactivateNote();
    }
    dom.textModeBtn.classList.toggle('on', state.textMode);
    save();
  });

  // Initial state visualisation
  dom.textModeBtn.classList.toggle('on', !state.drawMode && !!state.textMode);
  dom.drawModeBtn.classList.toggle('on', !!state.drawMode);
  dom.noteModeBtn.classList.toggle('on', !!state.noteMode);
  if (state.noteMode) {
    dom.noteToolbar.classList.add('visible');
    renderNoteToolbar();
  }
  syncDraw();
}

// ── Fullscreen FAB ──────────────────────────────────────────────────
export function initFullscreen() {
  dom.fullBtn.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else                              await document.exitFullscreen();
    } catch {}
    dom.fullBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
  });
  document.addEventListener('fullscreenchange', () => {
    dom.fullBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
  });
}

// ── Global click → close drawer / dismiss note-mode ─────────────────
export function initGlobalClickHandlers() {
  document.addEventListener('click', (e) => {
    // Drawer auto-close: ignore clicks on the drawer itself, the hamburger, or
    // the new top-left board-name pill (also a drawer trigger in v2.0).
    const onPill = dom.boardPill && dom.boardPill.contains(e.target);
    if (!dom.drawer.contains(e.target) && e.target !== dom.hamburger && !onPill) _openDrawer(false);

    if (!dom.noteToolbar.contains(e.target) && e.target !== dom.noteModeBtn) {
      state.noteMode = false;
      dom.noteModeBtn.classList.remove('on');
      dom.noteToolbar.classList.remove('visible');
    }

    if (state.textMode && !e.target.closest('.note') && !e.target.closest('#textToolbar')) {
      deactivateNote();
    }
  });
}
