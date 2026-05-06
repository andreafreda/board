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
  // v2.0.19: clamp to a [4..18] visible range and centre block-level.
  // Below ~4 px the dot is just a sub-pixel smear that looks
  // off-centre; above ~18 px it overflows the wrap. The actual stroke
  // width is reflected by the value label, not by this swatch.
  const d  = Math.max(4, Math.min(sz, 18));
  dom.drawSliderPreview.innerHTML =
    `<span style="display:block;width:${d}px;height:${d}px;border-radius:999px;
      margin:0 auto;background:${state.eraser ? 'var(--muted)' : state.penColor};opacity:.85;"></span>`;
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

  // v2.0.12: rainbow "custom color" swatch — opens a native color picker.
  // Highlighted when state.penColor isn't one of the quick colors.
  const isPreset = PEN_COLORS.includes(state.penColor);
  const customWrap = document.createElement('label');
  customWrap.className = 'tb-dot tb-dot-custom' + (!isPreset ? ' active' : '');
  customWrap.title = 'Colore personalizzato';
  customWrap.style.cssText = !isPreset
    ? `background:${state.penColor};width:22px;height:22px;`
    : 'width:22px;height:22px;';
  const colorIn = document.createElement('input');
  colorIn.type = 'color';
  colorIn.value = isPreset ? '#ff5500' : state.penColor;
  colorIn.addEventListener('input', () => {
    state.penColor = colorIn.value;
    state.eraser = false;
    renderDrawToolbar();
    updateDrawPreview();
    save();
  });
  customWrap.appendChild(colorIn);
  dom.penColors.appendChild(customWrap);

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

  // v2.0.12: custom color swatch for text too.
  const isPreset = TEXT_COLORS.includes(note.textColor);
  const customWrap = document.createElement('label');
  customWrap.className = 'tb-dot tb-dot-custom' + (!isPreset ? ' active' : '');
  customWrap.title = 'Colore personalizzato';
  customWrap.style.cssText = !isPreset
    ? `background:${note.textColor};width:22px;height:22px;`
    : 'width:22px;height:22px;';
  const colorIn = document.createElement('input');
  colorIn.type = 'color';
  colorIn.value = isPreset ? '#ff5500' : note.textColor;
  colorIn.addEventListener('input', (e) => {
    e.stopPropagation();
    note.textColor = colorIn.value;
    const an = getActiveNote();
    if (an && an.note.id === note.id) an.el.querySelector('textarea').style.color = colorIn.value;
    renderTextToolbar(note); save();
    broadcastNoteUpsert(note);
  });
  customWrap.appendChild(colorIn);
  dom.txtColors.appendChild(customWrap);

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

// ── Calendar mode (v3) — toggle the calendar view on/off ───────────
export function initCalendarMode() {
  // Resolve fresh from the DOM in case dom.* was created before the
  // calendar HTML was added to the page (defensive — the element is in
  // the file but ES module evaluation order can race in some setups).
  const btn = dom.calendarModeBtn || document.getElementById('calendarModeBtn');
  if (!btn) { console.warn('[v3] calendarModeBtn not found'); return; }
  console.info('[v3] calendar wired');

  // Lazy-load the calendar module on first toggle so guests / users who
  // never open the calendar don't pay its render cost.
  let _calMod = null;
  const load = async () => {
    if (_calMod) return _calMod;
    _calMod = await import('./calendar.js');
    _calMod.initCalendar();
    // Hand the calendar a "leave" callback so its in-header back button can
    // trigger a clean exit without a circular import on modes.js.
    _calMod.setOnLeave(() => setOn(false));
    return _calMod;
  };

  const setOn = async (on) => {
    const mod = await load();
    mod.setActive(on);
    btn.classList.toggle('on', on);
    if (on) exitAllModes();
  };

  btn.addEventListener('click', () => setOn(!btn.classList.contains('on')));
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
    // Drawer auto-close: any click outside the drawer chrome should close it,
    // EXCEPT clicks that originated inside one of its known triggers.
    // (We must use .contains() — when the hamburger holds an <img> avatar
    // or the mode buttons hold an <svg>, e.target is the descendant element,
    // not the button itself, so a strict === check would close the drawer
    // even when the user clicked the trigger.)
    const onTrigger =
      (dom.hamburger && dom.hamburger.contains(e.target)) ||
      (dom.boardPill && dom.boardPill.contains(e.target));
    if (!dom.drawer.contains(e.target) && !onTrigger) _openDrawer(false);

    if (!dom.noteToolbar.contains(e.target) && !dom.noteModeBtn.contains(e.target)) {
      state.noteMode = false;
      dom.noteModeBtn.classList.remove('on');
      dom.noteToolbar.classList.remove('visible');
    }

    if (state.textMode && !e.target.closest('.note') && !e.target.closest('#textToolbar')) {
      deactivateNote();
    }
  });
}
