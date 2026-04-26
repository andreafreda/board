// ════════════════════════════════════════════════════════════════════
//   state.js — single source of truth for the app
// ════════════════════════════════════════════════════════════════════
// Owns: the global `state` object, persistence (localStorage), and the
// small "promote active board" trick that keeps the existing flat-state
// code working (state.boardW / state.notes / state.strokes mirror the
// active entry in state.boards).
//
// Other modules subscribe to events for the few cross-cutting actions
// (save → schedule cloud save, view-mode change → guard rendering).

// ── Constants ────────────────────────────────────────────────────────
export const STORAGE_KEY = 'board-lite-v10';
export const PREFS_KEY   = 'board-lite-v10-prefs';

export const NOTE_COLORS = ['yellow','pink','blue','green','lilac','orange','mint'];
export const NOTE_COLOR_MAP = {
  yellow:'#f5e36d', pink:'#f6bfd0', blue:'#bfe0f6', green:'#cbe8be',
  lilac:'#dcccf7', orange:'#ffd3a1', mint:'#bfeedc',
};
export const PEN_COLORS  = ['#1f2328','#0f6f76','#d94848','#2563eb','#16a34a','#9333ea','#ea580c','#ffffff'];
export const TEXT_COLORS = ['#1f2328','#d94848','#0f6f76','#2563eb','#16a34a','#9333ea','#7c3f00'];

export const PRESETS = [
  { label:'🖥️', title:'Desktop 1920×1080', w:1920, h:1080 },
  { label:'💻', title:'Laptop 1366×768',   w:1366, h:768  },
  { label:'📺', title:'Full HD 1280×720',  w:1280, h:720  },
  { label:'📟', title:'Tablet 768×1024',   w:768,  h:1024 },
  { label:'📱', title:'Mobile 390×844',    w:390,  h:844  },
];

export const PEN_MIN = 1,  PEN_MAX = 40;
export const ERASER_MIN = 8, ERASER_MAX = 100;
export const FONT_MIN = 10, FONT_MAX = 36;

// ── Helpers ──────────────────────────────────────────────────────────
export const uid    = () => crypto.randomUUID();
export const clone  = (o) => JSON.parse(JSON.stringify(o));
export const fmtTime = () => new Date().toLocaleTimeString('it-IT', { hour:'2-digit', minute:'2-digit' });
export const fmtDate = () => new Date().toLocaleDateString('it-IT', { weekday:'short', day:'numeric', month:'short' });

export function mkBoard(opts = {}) {
  return {
    id: uid(), name: 'Board',
    width: 1366, height: 768,
    panX: 0, panY: 0,
    notes: [], strokes: [],
    visibility: 'private',
    ...opts,
  };
}

// ── Default state shape ──────────────────────────────────────────────
const DEFAULTS = {
  showClock: true,
  drawMode: false, textMode: false, noteMode: false,
  noteColor: 'yellow',
  penColor: '#1f2328', penSize: 7,
  eraser: false, eraserSize: 28,
  activeBoardId: null, boards: [],
};

// ── Hydrate from localStorage (with v1 flat → v10 boards migration) ─
function loadInitialState() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}

  // Migrate old flat format (notes/strokes at top level → wrap in a board)
  if (!raw.boards && raw.notes) {
    const b = mkBoard({
      width:  raw.boardW || 1366,
      height: raw.boardH || 768,
      panX:   raw.panX   || 0,
      panY:   raw.panY   || 0,
      notes:  raw.notes  || [],
      strokes: raw.strokes || [],
    });
    raw = { ...raw, boards: [b], activeBoardId: b.id };
  }

  const s = { ...DEFAULTS, ...raw };

  // Ensure at least one board exists and the active id points to it
  if (!s.boards?.length) {
    const b = mkBoard();
    s.boards = [b]; s.activeBoardId = b.id;
  }
  if (!s.boards.find(b => b.id === s.activeBoardId)) {
    s.activeBoardId = s.boards[0].id;
  }

  // Promote active board fields into the flat state for legacy code
  const ab = s.boards.find(b => b.id === s.activeBoardId);
  s.boardW = ab.width;  s.boardH = ab.height;
  s.panX   = ab.panX || 0; s.panY = ab.panY || 0;
  s.notes  = ab.notes  || [];
  s.strokes = ab.strokes || [];

  return s;
}

export const state = loadInitialState();

// ── View-mode flag (single source) ───────────────────────────────────
let _viewMode = false;
export const isViewMode    = () => _viewMode;
export const setViewMode   = (v) => { _viewMode = !!v; };

// ── Active-board sync (flat state ↔ boards[]) ───────────────────────
export function syncActiveBoard() {
  const b = state.boards.find(b => b.id === state.activeBoardId);
  if (!b) return;
  b.width   = state.boardW;
  b.height  = state.boardH;
  b.panX    = state.panX;
  b.panY    = state.panY;
  b.notes   = state.notes;
  b.strokes = state.strokes;
}

export function loadBoardIntoState(b) {
  state.boardW  = Number(b.width)  || 1366;
  state.boardH  = Number(b.height) || 768;
  state.panX    = b.panX || 0;
  state.panY    = b.panY || 0;
  state.notes   = b.notes   || [];
  state.strokes = b.strokes || [];
  document.title = b.name || 'Board';
}

// ── Save (gated by view mode + auth state) ──────────────────────────
// Wired by main.js: setSaveHook({ getCurrentUser, scheduleSbSave })
let _saveHook = { getCurrentUser: () => null, scheduleSbSave: () => {} };
export function setSaveHook(hook) { _saveHook = { ..._saveHook, ...hook }; }

export function save() {
  if (_viewMode) return;
  syncActiveBoard();
  const isUser = !!_saveHook.getCurrentUser();
  if (!isUser) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  } else {
    // Persist only UI prefs locally when logged in
    const prefs = {
      showClock: state.showClock,
      noteColor: state.noteColor,
      penColor:  state.penColor,
      penSize:   state.penSize,
      eraser:    state.eraser,
      eraserSize: state.eraserSize,
      drawMode:  state.drawMode,
      textMode:  state.textMode,
      noteMode:  state.noteMode,
      activeBoardId: state.activeBoardId,
    };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
    _saveHook.scheduleSbSave();
  }
}
