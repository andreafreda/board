// ════════════════════════════════════════════════════════════════════
//   main.js — bootstrap
// ════════════════════════════════════════════════════════════════════
// Wires the modules together, runs the initial render, and handles the
// shared-link flow (?board=<uuid>).
//
// Order matters:
//   1. Wire cross-module hooks (state ↔ board ↔ notes)
//   2. Run the synchronous initial render (so the user sees their
//      stored state instantly).
//   3. Resolve auth and possibly enter view mode.

import { dom } from './dom.js';
import { state, isViewMode, loadBoardIntoState } from './state.js';
import {
  applyBoardSize, applyPan, clampPan,
  initSketchCanvas, redrawBoard, initSketchHandlers, initPan,
  setAfterApply, initViewModeExitButton,
} from './board.js';
import { renderNotes } from './notes.js';
import {
  initModes, initFullscreen, initGlobalClickHandlers,
  initClock, initDrawSlider, initTxtSlider, setDrawerToggle,
} from './modes.js';
import {
  initDrawer, initDrawerActions,
  renderBoardList, renderPresets, openDrawer,
} from './drawer.js';
import { initAuth, renderAuth, getCurrentUser } from './auth.js';
import { getClient } from './db.js';
import { loadPublicBoard } from './share.js';
import { statusInit } from './status.js';

// ── Wire cross-module hooks ─────────────────────────────────────────
// applyBoardSize() needs to call renderNotes + redrawBoard but board.js
// shouldn't import notes.js (would be a layering violation) — we inject
// the side-effect here instead.
setAfterApply(() => { renderNotes(); redrawBoard(); });

// modes.js needs to be able to close the drawer
setDrawerToggle(openDrawer);

// ── Synchronous initial render ──────────────────────────────────────
function initialRender() {
  dom.board.style.width  = state.boardW + 'px';
  dom.board.style.height = state.boardH + 'px';
  initSketchCanvas();
  applyPan();
  renderNotes();
  redrawBoard();
  document.title = state.boards.find((b) => b.id === state.activeBoardId)?.name || 'Board';
  renderBoardList();
  renderPresets();
}

initDrawer();
initDrawerActions();
initSketchHandlers();
initPan();
initModes();
initFullscreen();
initGlobalClickHandlers();
initClock();
initDrawSlider();
initTxtSlider();
initViewModeExitButton();
initAuth();
statusInit();
initialRender();

// ── Bootstrap (auth + optional view mode) ──────────────────────────
(async () => {
  const urlBoard = new URLSearchParams(location.search).get('board');

  // Always run the auth flow so Supabase boards replace any stale
  // localStorage data and the share-link case can decide ownership.
  try {
    const client = await getClient();
    const { data: { session } } = await client.auth.getSession();
    if (window.opener && session) { window.close(); return; }
    await renderAuth(session);

    // Only react to actual sign-in / sign-out events. Skip
    // INITIAL_SESSION (already handled) and TOKEN_REFRESHED noise.
    client.auth.onAuthStateChange(async (event, sess) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        await renderAuth(sess);
      }
    });
  } catch {
    await renderAuth(null);
  }

  // If a board id is in the URL, decide what to do after auth is settled.
  if (urlBoard) {
    // Only treat as "owned" if the user is actually logged in AND the id
    // is in their Supabase boards (never trust stale localStorage).
    const ownBoard = getCurrentUser()
      ? state.boards.find((b) => b.id === urlBoard)
      : null;

    if (ownBoard) {
      state.activeBoardId = ownBoard.id;
      loadBoardIntoState(ownBoard);
      applyBoardSize(ownBoard.width, ownBoard.height);
      renderBoardList();
      renderPresets();
      history.replaceState({}, '', location.pathname);
      document.documentElement.classList.remove('pending-view');
      // If we just activated a cooperative board via the URL, join channel
      const { syncCollabChannel } = await import('./collab.js');
      syncCollabChannel();
    } else {
      const ok = await loadPublicBoard(urlBoard);
      // If loadPublicBoard failed (board not found / private), still
      // reveal the UI so the user isn't stuck on a blank page.
      if (!ok && !isViewMode()) {
        document.documentElement.classList.remove('pending-view');
      }
    }
  }
})();
