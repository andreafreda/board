// ════════════════════════════════════════════════════════════════════
//   auth.js — Google OAuth + Supabase session lifecycle
// ════════════════════════════════════════════════════════════════════

import { dom } from './dom.js';
import {
  state, isViewMode, syncActiveBoard, loadBoardIntoState, mkBoard,
  setSaveHook, STORAGE_KEY,
} from './state.js';
import { applyBoardSize } from './board.js';
import { renderBoardList, renderPresets, setAuthHooks } from './drawer.js';
import {
  getClient,
  sbLoadBoards, sbCreateBoard, sbUpdateBoardName,
  sbDeleteBoard, sbUpdateVisibility, sbSaveActiveBoard,
  sbListMembers, sbAddMember, sbUpdateMemberRole, sbRemoveMember,
} from './db.js';

const GOOGLE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24">
  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
</svg>`;

// ── Single source of truth for the current user ─────────────────────
let currentUser = null;
export const getCurrentUser = () => currentUser;

// ── Debounced cloud save (called from state.save() when logged in) ──
let sbSaveTimer = null;
async function doSbSave() {
  if (!currentUser) return;
  const client = await getClient();
  syncActiveBoard();
  const b = state.boards.find((bd) => bd.id === state.activeBoardId);
  if (!b) return;
  // Defensive role default: if myRole is missing the board is treated as our
  // own (we'd never have loaded it otherwise), so 'owner'.
  const role = b.myRole || 'owner';
  await sbSaveActiveBoard(client, currentUser.id, b, role);
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
    if (dom.userName) dom.userName.textContent = name;
  } else {
    currentUser = null;
    dom.userRow.style.display  = 'none';
    dom.guestRow.style.display = '';
    dom.googleBtn.disabled = false;
    dom.googleBtn.innerHTML = GOOGLE_SVG;
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
  } catch (err) {
    console.error('Supabase board load failed:', err);
    renderBoardList();
  }
}

// ── Guest path: rehydrate from localStorage ─────────────────────────
function restoreGuestBoardsFromLocalStorage() {
  // Save current logged-in state to localStorage before switching to guest
  syncActiveBoard();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}

  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}

  if (!raw.boards?.length) {
    const b = {
      id: crypto.randomUUID(), name: 'Board',
      width: raw.boardW || 1366, height: raw.boardH || 768,
      panX: 0, panY: 0,
      notes: raw.notes || [], strokes: raw.strokes || [],
    };
    raw.boards = [b]; raw.activeBoardId = b.id;
  }
  const active = raw.boards.find((b) => b.id === raw.activeBoardId) || raw.boards[0];
  state.boards = raw.boards;
  state.activeBoardId = active.id;
  loadBoardIntoState(active);
  applyBoardSize(active.width, active.height);
  renderBoardList();
  renderPresets();
}

// ── Wire the OAuth popup + sign-out + state hooks ───────────────────
export function initAuth() {
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
  });

  dom.googleBtn.addEventListener('click', async () => {
    dom.googleBtn.disabled = true;
    dom.googleBtn.innerHTML = '<span class="auth-spinner"></span>';
    try {
      const client     = await getClient();
      const redirectTo = window.location.href.split('?')[0].split('#')[0];
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options:  { redirectTo, skipBrowserRedirect: true },
      });
      if (error || !data?.url) throw error ?? new Error('OAuth error');

      const popup = window.open(
        data.url, 'sb-oauth',
        'width=520,height=640,popup=yes,left=' +
          Math.round(window.screenX + (window.outerWidth  - 520) / 2) +
          ',top=' + Math.round(window.screenY + (window.outerHeight - 640) / 2),
      );
      if (!popup) { window.location.href = data.url; return; }

      // The onAuthStateChange listener installed in main.js will pick up
      // SIGNED_IN once the popup completes — no need to manually call
      // renderAuth here (which would just duplicate work).
      const iv = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(iv);
      }, 600);
    } catch {
      await renderAuth(null);
    }
  });

  dom.logoutBtn.addEventListener('click', async () => {
    (await getClient()).auth.signOut();
  });
}
