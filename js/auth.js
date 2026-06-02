// ════════════════════════════════════════════════════════════════════
//   auth.js — Google OAuth + Supabase session lifecycle
// ════════════════════════════════════════════════════════════════════

import { dom } from './dom.js';
import {
  state, isViewMode, syncActiveBoard, loadBoardIntoState, mkBoard,
  setSaveHook, STORAGE_KEY, PREFS_KEY,
} from './state.js';
import { applyBoardSize } from './board.js';
import { renderBoardList, renderPresets, setAuthHooks } from './drawer.js';
import {
  getClient,
  sbLoadBoards, sbCreateBoard, sbUpdateBoardName,
  sbDeleteBoard, sbUpdateVisibility, sbSaveActiveBoard,
  sbListMembers, sbAddMember, sbUpdateMemberRole, sbRemoveMember,
  sbExportAllMyData, sbDeleteAllMyData,
} from './db.js';
import { setUserGetter, syncCollabChannel, leaveCollab } from './collab.js';
import { setLoggedIn, beginSave, endSave } from './status.js';

const GOOGLE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24">
  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
</svg>`;

// ── Single source of truth for the current user ─────────────────────
let currentUser = null;
export const getCurrentUser = () => currentUser;
// Wire collab.js so it can read the current user without circular imports
setUserGetter(getCurrentUser);

// ── Debounced cloud save (called from state.save() when logged in) ──
let sbSaveTimer = null;
async function doSbSave() {
  if (!currentUser) return;
  beginSave();
  try {
    const client = await getClient();
    syncActiveBoard();
    const b = state.boards.find((bd) => bd.id === state.activeBoardId);
    if (!b) return;
    // Defensive role default: if myRole is missing the board is treated as our
    // own (we'd never have loaded it otherwise), so 'owner'.
    const role = b.myRole || 'owner';
    await sbSaveActiveBoard(client, currentUser.id, b, role);
  } catch (err) {
    console.error('Cloud save failed:', err);
  } finally {
    endSave();
  }
}
function scheduleSbSave() {
  clearTimeout(sbSaveTimer);
  sbSaveTimer = setTimeout(doSbSave, 1500);
}

// ── Auth UI chrome (avatar / name / sign-in / sign-out) ─────────────
function renderAuthChrome(session) {
  if (session?.user) {
    currentUser = session.user;
    const meta   = session.user.user_metadata ?? {};
    const name   = meta.full_name ?? meta.name ?? meta.user_name
                ?? session.user.email?.split('@')[0] ?? '?';
    const avatar = meta.avatar_url ?? meta.picture ?? null;

    dom.guestRow.style.display = 'none';
    dom.userRow.style.display  = 'flex';
    dom.avatarEl.innerHTML = avatar
      ? `<img src="${avatar}" alt="" style="width:100%;height:100%;border-radius:999px;object-fit:cover;">`
      : name.charAt(0).toUpperCase();
    if (dom.userName)  dom.userName.textContent  = name;
    if (dom.userEmail) dom.userEmail.textContent = session.user.email || '';

    // v2.0: mirror the avatar into the top-right hamburger button so it
    // becomes the visible "user menu" entry-point as in the design.
    if (dom.hamburger) {
      dom.hamburger.classList.add('avatar-mode');
      dom.hamburger.innerHTML = avatar
        ? `<img src="${avatar}" alt="" style="width:100%;height:100%;border-radius:999px;object-fit:cover;">`
        : name.charAt(0).toUpperCase();
    }

    setLoggedIn(true);
  } else {
    currentUser = null;
    dom.userRow.style.display  = 'none';
    dom.guestRow.style.display = '';
    dom.googleBtn.disabled = false;
    dom.googleBtn.innerHTML = GOOGLE_SVG;

    if (dom.hamburger) {
      dom.hamburger.classList.remove('avatar-mode');
      dom.hamburger.textContent = '☰';
    }

    setLoggedIn(false);
  }
}

// ── Full auth render: chrome + board state ──────────────────────────
export async function renderAuth(session) {
  renderAuthChrome(session);

  // ⚠ View mode guard: when displaying a shared board read-only, never
  // touch board state from here. onAuthStateChange fires INITIAL_SESSION
  // shortly after registering the listener; without this guard it would
  // overwrite state.notes/strokes (set by enterViewMode) with the user's
  // own active board and leave the UI inconsistent (banner says one
  // thing, board content shows another).
  if (isViewMode()) return;

  if (session?.user) {
    // v3.2.8: if we're running inside the OAuth popup opened by the HA iframe,
    // send the session back via postMessage (bypasses Chrome's third-party
    // storage partitioning that prevents localStorage sync across contexts),
    // then close the popup. The iframe listener calls setSession() directly.
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage({
          type:         '__board_oauth',
          accessToken:  session.access_token,
          refreshToken: session.refresh_token,
        }, 'https://andreafreda.github.io');
      } catch (e) { console.warn('[auth] postMessage failed:', e); }
      // Small delay so postMessage is delivered before the window closes
      await new Promise(r => setTimeout(r, 200));
      try { window.close(); } catch {}
      return;
    }

    // v3.2.6: fallback — if popup was blocked and top-frame redirect was used,
    // the user lands on the standalone board. If a ?return= URL was saved to
    // localStorage by the iframe, redirect back to HA.
    if (window.self === window.top) {
      const raw = localStorage.getItem('__board_ha_return');
      if (raw) {
        try {
          const { url, t } = JSON.parse(raw);
          if (typeof url === 'string' && Date.now() - t < 30 * 60 * 1000) {
            localStorage.removeItem('__board_ha_return');
            window.location.href = url;
            return;
          }
        } catch {}
        localStorage.removeItem('__board_ha_return');
      }
    }
    await loadCloudBoardsForUser(session);
  } else {
    restoreGuestBoardsFromLocalStorage();
  }
}

// ── Logged-in path: Supabase boards become the source of truth ─────
async function loadCloudBoardsForUser(session) {
  try {
    const client = await getClient();

    // Step 1: load the user's existing cloud boards FIRST so we know
    //         what already exists before deciding what to push. This now
    //         also includes cooperative boards the user is a member of.
    let boards = await sbLoadBoards(client, session.user.id, session.user.email);
    const cloudIds = new Set((boards || []).map((b) => b.id));

    // Step 2: push the active local board only if it has content AND
    //         is not already in the cloud AND isn't owned by someone else.
    let savedGuestBoardId = null;
    syncActiveBoard();
    const gb = state.boards.find((b) => b.id === state.activeBoardId)
            || state.boards[0];
    const hasContent = gb && ((gb.notes?.length > 0) || (gb.strokes?.length > 0));

    if (hasContent && !cloudIds.has(gb.id)) {
      // Defensive: check if id exists in DB at all (would be a public
      // board not owned by us — RLS lets us SELECT it but not UPDATE).
      const { data: existing } = await client
        .from('boards').select('id,owner_id').eq('id', gb.id).maybeSingle();
      const ownedByOther = existing && existing.owner_id !== session.user.id;

      if (!ownedByOther) {
        savedGuestBoardId = gb.id;
        await sbSaveActiveBoard(client, session.user.id, gb, 'owner');
        boards = await sbLoadBoards(client, session.user.id, session.user.email);
      }
    }

    // Step 3: ensure the user has at least one board
    if (!boards?.length) {
      const d = mkBoard();
      await sbCreateBoard(client, session.user.id, d);
      boards = [d];
      boards[0].myRole = 'owner';
    }

    // Step 4: install boards as the new state and render
    const preferredId = savedGuestBoardId || state.activeBoardId;
    const active = boards.find((b) => b.id === preferredId) || boards[0];
    state.boards = boards;
    state.activeBoardId = active.id;
    loadBoardIntoState(active);
    applyBoardSize(active.width, active.height);
    renderBoardList();
    renderPresets();
    // If the user landed on a cooperative board, open the realtime channel
    syncCollabChannel();
  } catch (err) {
    console.error('Supabase board load failed:', err);
    renderBoardList();
  }
}

// ── Guest path: rehydrate from localStorage ─────────────────────────
function restoreGuestBoardsFromLocalStorage() {
  // ⚠ SECURITY: do NOT persist the current (logged-in) state.boards into
  // STORAGE_KEY before reading it back — that would leave the previous
  // user's cloud boards accessible to anyone opening the browser as
  // guest after a sign-out.
  //
  // Wipe PREFS_KEY too: its activeBoardId is a cloud uuid that no longer
  // resolves once the user is signed out.
  try { localStorage.removeItem(PREFS_KEY); } catch {}

  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}

  if (!raw.boards?.length) {
    const b = {
      id: crypto.randomUUID(), name: 'Board',
      width: 1366, height: 768,
      panX: 0, panY: 0,
      notes: [], strokes: [],
      visibility: 'private',
    };
    raw.boards = [b]; raw.activeBoardId = b.id;
  }
  const active = raw.boards.find((b) => b.id === raw.activeBoardId) || raw.boards[0];
  state.boards = raw.boards;
  state.activeBoardId = active.id;
  // Strip any private tags inherited from cloud-mode in-memory state
  state.notes   = [];
  state.strokes = [];
  loadBoardIntoState(active);
  applyBoardSize(active.width, active.height);
  renderBoardList();
  renderPresets();
  // Guest is never on a cooperative board — make sure the channel is closed
  leaveCollab();
}

// ── Wire the OAuth popup + sign-out + state hooks ───────────────────
export function initAuth() {
  // v3.2.6: if the board is embedded in HA via an iframe URL like
  //   https://andreafreda.github.io/board/?return=https://ha.example.com
  // save that return URL to localStorage so that after OAuth (which lands
  // the user on the standalone board) we can redirect them back to HA.
  try {
    const returnParam = new URLSearchParams(window.location.search).get('return');
    if (returnParam) {
      const parsed = new URL(returnParam);
      // Safety: only store URLs that point to a different origin
      if (parsed.origin !== window.location.origin) {
        localStorage.setItem('__board_ha_return', JSON.stringify({ url: returnParam, t: Date.now() }));
      }
    }
  } catch {}

  // v3.2.8: receive the session posted back from the OAuth popup.
  // Chrome partitions localStorage per (origin × top-level-origin), so the
  // popup (top-level andreafreda.github.io) and the HA iframe (embedded in
  // ha.andreafreda.cloud) have separate storage — Supabase's built-in
  // cross-tab sync never fires across them. postMessage bypasses this.
  window.addEventListener('message', async (e) => {
    if (e.origin !== 'https://andreafreda.github.io') return;
    if (e.data?.type !== '__board_oauth') return;
    try {
      const client = await getClient();
      const { error } = await client.auth.setSession({
        access_token:  e.data.accessToken,
        refresh_token: e.data.refreshToken,
      });
      if (error) console.warn('[auth] setSession error:', error);
      // onAuthStateChange fires automatically → renderAuth(session) → board loads
    } catch (err) {
      console.warn('[auth] popup session injection failed:', err);
    }
  });

  // Wire state.save() so it can schedule a cloud save when logged in
  setSaveHook({ getCurrentUser, scheduleSbSave });

  // Give drawer.js the auth-aware operations it needs
  setAuthHooks({
    getCurrentUser,
    sbCreateBoard:      async (b)  => { const c = await getClient(); return sbCreateBoard(c, currentUser?.id, b); },
    sbDeleteBoard:      async (id) => { const c = await getClient(); return sbDeleteBoard(c, currentUser?.id, id); },
    sbUpdateBoardName:  async (id, name) => { const c = await getClient(); return sbUpdateBoardName(c, currentUser?.id, id, name); },
    sbUpdateVisibility: async (id, vis)  => { const c = await getClient(); return sbUpdateVisibility(c, currentUser?.id, id, vis); },
    // Members CRUD
    sbListMembers:      async (id)              => { const c = await getClient(); return sbListMembers(c, id); },
    sbAddMember:        async (id, email, role) => { const c = await getClient(); return sbAddMember(c, id, email, role); },
    sbUpdateMemberRole: async (id, email, role) => { const c = await getClient(); return sbUpdateMemberRole(c, id, email, role); },
    sbRemoveMember:     async (id, email)       => { const c = await getClient(); return sbRemoveMember(c, id, email); },
    // GDPR
    sbExportAllMyData:  async () => {
      const c = await getClient();
      return sbExportAllMyData(c, currentUser?.id, currentUser?.email);
    },
    sbDeleteAllMyData:  async () => {
      const c = await getClient();
      return sbDeleteAllMyData(c, currentUser?.id, currentUser?.email);
    },
  });

  dom.googleBtn.addEventListener('click', async () => {
    // v2.0.13: full-page redirect for standalone tab.
    // v3.2.9:  iframe flow — popup opened synchronously + postMessage session.
    //
    // Google blocks OAuth inside cross-origin iframes (403). Fix:
    // 1. Open a popup from the iframe's OWN window SYNCHRONOUSLY (before any
    //    await) so the user-gesture budget is still active and Chrome allows it.
    // 2. Navigate the popup to the OAuth URL after getting it (async).
    // 3. After login the popup calls window.opener.postMessage(tokens) back to
    //    the iframe, then closes. The iframe calls setSession() directly,
    //    bypassing Chrome's third-party storage partitioning that prevents
    //    localStorage sync between popup and embedded iframe.
    // Fallback if popup is blocked: navigate the top frame (HA) and use
    // ?return= to come back.
    dom.googleBtn.disabled = true;
    dom.googleBtn.innerHTML = '<span class="auth-spinner"></span>';
    try {
      const redirectTo = 'https://andreafreda.github.io/board/';
      const inIframe   = window.self !== window.top;

      // ── IFRAME PATH ──────────────────────────────────────────────────────
      if (inIframe) {
        // Step 1 — open popup NOW (synchronous, user gesture still active).
        let popup = null;
        try {
          popup = window.open('', '_blank', 'popup,width=520,height=620,left=200,top=100');
        } catch {}

        // Step 2 — get OAuth URL (async; gesture budget no longer required).
        const client = await getClient();
        const { data, error } = await client.auth.signInWithOAuth({
          provider: 'google',
          options:  { redirectTo, skipBrowserRedirect: true },
        });
        if (error) throw error;

        if (data?.url) {
          if (popup && !popup.closed) {
            popup.location.href = data.url;           // → Google → board → postMessage → close
            dom.googleBtn.disabled  = false;
            dom.googleBtn.innerHTML = GOOGLE_SVG;
            return;
          }
          // Popup blocked — fall back to top-frame navigation.
          try { window.top.location.href = data.url; } catch { window.location.href = data.url; }
          return;
        }
        dom.googleBtn.disabled  = false;
        dom.googleBtn.innerHTML = GOOGLE_SVG;
        return;
      }

      // ── STANDALONE PATH ──────────────────────────────────────────────────
      const client = await getClient();
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options:  { redirectTo },
      });
      if (error) throw error;
      // supabase performs a full-page redirect; if we reach here (rare) restore.
      setTimeout(() => {
        if (!currentUser) {
          dom.googleBtn.disabled  = false;
          dom.googleBtn.innerHTML = GOOGLE_SVG;
        }
      }, 4000);
    } catch (e) {
      console.warn('OAuth error:', e);
      dom.googleBtn.disabled  = false;
      dom.googleBtn.innerHTML = GOOGLE_SVG;
    }
  });

  if (dom.logoutBtn) {
    dom.logoutBtn.addEventListener('click', async () => {
      // v2.0.9: harden the logout flow.
      //  * disable the button while the request is in flight (multiple
      //    clicks were silently queueing redundant signOuts);
      //  * await the call so we can surface failures;
      //  * always force a renderAuth(null) afterwards — onAuthStateChange
      //    sometimes doesn't fire (e.g. when the local session was already
      //    invalid) and the UI was left in 'logged-in' state.
      dom.logoutBtn.disabled = true;
      try {
        const client = await getClient();
        const { error } = await client.auth.signOut();
        if (error) console.warn('signOut error:', error);
      } catch (e) {
        console.warn('signOut threw:', e);
      } finally {
        dom.logoutBtn.disabled = false;
      }
      try { await renderAuth(null); } catch {}
    });
  }
}
