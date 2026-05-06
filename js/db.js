// ════════════════════════════════════════════════════════════════════
//   db.js — Supabase client + per-board CRUD
// ════════════════════════════════════════════════════════════════════
// Lazily creates the Supabase client on first call (no network hit on
// app boot). All write paths explicitly filter by owner_id so RLS never
// has to clean up after us.

const SUPABASE_URL = 'https://qphyrsdtegxvnwaqixeb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwaHlyc2R0ZWd4dm53YXFpeGViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzAxMzAsImV4cCI6MjA5MjYwNjEzMH0.DbFOqe5TcyejFPSqbPwq8menddWNoAKn1BapoOgDKkY';

let _client = null;
export async function getClient() {
  if (_client) return _client;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  // v2.0.14: spell out the auth options.
  // detectSessionInUrl reads the OAuth hash on first load and persists it.
  // flowType='implicit' matches our redirect-based Google sign-in (the URL
  // comes back with #access_token=... and supabase-js parses it).
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'implicit',
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    },
  });
  return _client;
}

// ════════════════════════════════════════════════════════════════════
//   Board / notes / strokes — owner-scoped CRUD
// ════════════════════════════════════════════════════════════════════
//
// IMPORTANT: every SELECT for the user's own boards filters by owner_id.
// RLS *also* allows SELECT on visibility='public' rows, so a bare
// select('*') would leak public boards from other users into the list.

export async function sbLoadBoards(client, ownerId, email) {
  if (!ownerId) return null;

  // 1) The user's own boards (any visibility)
  const { data: ownBoards } = await client
    .from('boards').select('*').eq('owner_id', ownerId).order('created_at');

  // 2) Cooperative boards the user is a member of (by email)
  let memberRows = [];
  if (email) {
    const { data: m } = await client
      .from('board_members').select('board_id,role').eq('email', email);
    memberRows = m || [];
  }

  let coopBoards = [];
  if (memberRows.length) {
    const ids = memberRows.map((r) => r.board_id);
    const { data: cb } = await client
      .from('boards').select('*').in('id', ids).eq('visibility', 'cooperative');
    coopBoards = cb || [];
  }

  // Tag each cooperative board with the current user's role
  const roleByBoard = new Map(memberRows.map((r) => [r.board_id, r.role]));

  const all = [
    ...(ownBoards || []).map((b) => ({ ...b, _myRole: 'owner' })),
    ...coopBoards.map((b) => ({ ...b, _myRole: roleByBoard.get(b.id) || 'viewer' })),
  ];
  if (!all.length) return null;

  // Hydrate notes + strokes for every board in parallel.
  // Cooperative boards may have MANY strokes rows (one per writer) —
  // we flatten them all into a single combined array. Each note/stroke
  // gets its DB owner_id tagged onto it so save() can preserve ownership
  // and avoid stomping over other writers' rows.
  return Promise.all(all.map(async (b) => {
    const [{ data: notes }, { data: strokes }] = await Promise.all([
      client.from('notes').select('id,data,owner_id').eq('board_id', b.id),
      client.from('strokes').select('data,owner_id').eq('board_id', b.id),
    ]);
    const taggedNotes = (notes || []).map((r) => ({ ...r.data, _ownerId: r.owner_id }));
    const flatStrokes = (strokes || []).flatMap((r) =>
      (r.data || []).map((s) => ({ ...s, _ownerId: r.owner_id })),
    );
    return {
      id: b.id,
      name: b.name,
      width:  Number(b.width)  || 1366,
      height: Number(b.height) || 768,
      visibility: b.visibility || 'private',
      ownerId: b.owner_id,
      myRole:  b._myRole,           // 'owner' | 'editor' | 'viewer'
      panX: 0, panY: 0,
      notes:   taggedNotes,
      strokes: flatStrokes,
    };
  }));
}

export async function sbCreateBoard(client, ownerId, board) {
  if (!ownerId) return;
  await client.from('boards').upsert({
    id: board.id, owner_id: ownerId,
    name: board.name, width: board.width, height: board.height,
    visibility: board.visibility || 'private',
    updated_at: new Date().toISOString(),
  });
}

export async function sbUpdateBoardName(client, ownerId, id, name) {
  if (!ownerId) return;
  await client.from('boards')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', id).eq('owner_id', ownerId);
}

export async function sbDeleteBoard(client, ownerId, boardId) {
  if (!ownerId) return;
  // Explicit owner_id filter — RLS would block anyway, but be defensive.
  await client.from('boards').delete().eq('id', boardId).eq('owner_id', ownerId);
}

export async function sbUpdateVisibility(client, ownerId, boardId, vis) {
  if (!ownerId) return;
  await client.from('boards')
    .update({ visibility: vis, updated_at: new Date().toISOString() })
    .eq('id', boardId).eq('owner_id', ownerId);
}

// ── doSbSave: persist the active board + its notes + the writer's strokes row ─
//
// `writerId` is the user doing the save (auth.uid). For private/public boards
// it's the owner. For cooperative boards it's whichever editor is saving.
//
// Strokes are now stored one row per (board_id, owner_id) — each writer keeps
// their own row to avoid last-write-wins between cooperative editors.
//
// `role` controls what we save:
//   'owner'  → the boards row itself (name/size/visibility) AND notes AND strokes
//   'editor' → notes (per-row) + their own strokes row
//   'viewer' → nothing (defensive — viewers shouldn't trigger save)
//
// Notes carry an `_ownerId` tag (from sbLoadBoards) — we preserve it on
// upsert so cooperative editors don't accidentally take ownership of notes
// the board owner created. New notes created locally have no _ownerId
// and get the current writer as their owner.
//
// Strokes filter by _ownerId: each writer maintains their OWN strokes row
// (UNIQUE(board_id, owner_id)). We never include other writers' strokes
// in our own row — that would duplicate them on next load.
export async function sbSaveActiveBoard(client, writerId, board, role = 'owner') {
  if (!writerId || !board) return;
  if (role === 'viewer') return;
  const ts = new Date().toISOString();

  // ── strokes: keep only mine ──
  // (no _ownerId = locally drawn this session; matches writerId = previously
  // loaded as mine. Anything tagged with someone else's id gets dropped.)
  const stripOwner = (s) => { const { _ownerId, ...rest } = s; return rest; };
  const myStrokes = (board.strokes || [])
    .filter((s) => !s._ownerId || s._ownerId === writerId)
    .map(stripOwner);

  if (role === 'owner') {
    await client.from('boards').upsert({
      id: board.id, owner_id: writerId,
      name: board.name, width: board.width, height: board.height,
      visibility: board.visibility || 'private',
      updated_at: ts,
    });
  } else if (role === 'editor') {
    // Editors can't UPDATE the boards row directly (RLS blocks). We expose
    // a SECURITY DEFINER RPC that updates ONLY width/height — so resolution
    // changes by editors propagate to every cooperative member at refresh.
    if (Number.isFinite(board.width) && Number.isFinite(board.height)) {
      try {
        await client.rpc('set_board_size', {
          b_id: board.id, w: Math.round(board.width), h: Math.round(board.height),
        });
      } catch (err) {
        // Non-fatal: notes/strokes still get saved.
        console.warn('set_board_size RPC failed:', err?.message || err);
      }
    }
  }

  if (board.notes.length > 0) {
    await client.from('notes').upsert(
      board.notes.map((n) => ({
        id: n.id, board_id: board.id,
        // Preserve the original creator's ownership; default to current
        // writer for newly-created notes (no _ownerId yet).
        owner_id: n._ownerId || writerId,
        data: stripOwner(n),
        updated_at: ts,
      })),
    );
  }

  // Owner cleans up notes deleted from the board — but ONLY their own notes,
  // not those created by cooperative editors (which the owner sees but doesn't
  // necessarily have in their local state if they reload before the editor's
  // broadcast arrives). Without this filter the owner would silently delete
  // editors' notes during a normal save.
  if (role === 'owner') {
    const { data: existing } = await client
      .from('notes').select('id').eq('board_id', board.id).eq('owner_id', writerId);
    const curIds = new Set(board.notes.map((n) => n.id));
    const toDelete = (existing || []).map((r) => r.id).filter((id) => !curIds.has(id));
    if (toDelete.length) await client.from('notes').delete().in('id', toDelete);
  }

  // One strokes row per (board_id, owner_id) — onConflict on the unique pair
  await client.from('strokes').upsert({
    board_id: board.id, owner_id: writerId,
    data: myStrokes, updated_at: ts,
  }, { onConflict: 'board_id,owner_id' });
}

// ── Members ─────────────────────────────────────────────────────────
export async function sbListMembers(client, boardId) {
  const { data } = await client
    .from('board_members').select('email,role,added_at').eq('board_id', boardId).order('added_at');
  return data || [];
}

export async function sbAddMember(client, boardId, email, role = 'editor') {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('Email vuota');
  return client.from('board_members').upsert({
    board_id: boardId, email: e, role,
  }, { onConflict: 'board_id,email' });
}

export async function sbUpdateMemberRole(client, boardId, email, role) {
  return client.from('board_members')
    .update({ role }).eq('board_id', boardId).eq('email', email);
}

export async function sbRemoveMember(client, boardId, email) {
  return client.from('board_members').delete().eq('board_id', boardId).eq('email', email);
}

// ── GDPR: portability + right-to-erasure ────────────────────────────
//
// sbExportAllMyData: collects everything the app holds about the user
// into a single JSON blob — owned boards (with their notes, strokes,
// members) and the user's own membership records on cooperative boards
// owned by others. Read-only contents of those membership boards are
// NOT included (they belong to the other owner).
export async function sbExportAllMyData(client, userId, email) {
  if (!userId) return null;

  const { data: boards } = await client
    .from('boards').select('*').eq('owner_id', userId).order('created_at');

  const ownedBoards = await Promise.all((boards || []).map(async (b) => {
    const [{ data: notes }, { data: strokes }, { data: members }] = await Promise.all([
      client.from('notes').select('*').eq('board_id', b.id),
      client.from('strokes').select('*').eq('board_id', b.id),
      client.from('board_members').select('*').eq('board_id', b.id),
    ]);
    return {
      board:   b,
      notes:   notes   || [],
      strokes: strokes || [],
      members: members || [],
    };
  }));

  let memberships = [];
  if (email) {
    const { data } = await client
      .from('board_members').select('*').eq('email', email);
    memberships = data || [];
  }

  return {
    exportedAt: new Date().toISOString(),
    user: { id: userId, email: email || null },
    ownedBoards,
    memberships,
    note: 'Esportazione GDPR. Le board condivise con te (ma di proprietà altrui) sono solo riferite tramite la lista memberships — il loro contenuto appartiene al rispettivo owner.',
  };
}

// sbDeleteAllMyData: erases every record the user owns, removes them
// from any cooperative-member rows, then signs them out. ON DELETE
// CASCADE on the boards table takes care of notes/strokes/members
// belonging to those boards.
//
// Note: this does NOT delete the auth.users row itself — that requires
// service-role privileges and isn't safely callable from the client.
// The Google account record stays in Supabase auth, but with no data
// linked. Re-signing in produces a fresh empty account.
export async function sbDeleteAllMyData(client, userId, email) {
  if (!userId) return;
  // Owned boards (CASCADE drops notes/strokes/members of those boards)
  await client.from('boards').delete().eq('owner_id', userId);
  // Detach from any cooperative boards we were a member of
  if (email) {
    await client.from('board_members').delete().eq('email', email);
  }
  // Defensive: any leftover notes/strokes that referenced a different
  // owner_id but should still be ours
  await client.from('notes').delete().eq('owner_id', userId);
  await client.from('strokes').delete().eq('owner_id', userId);
  // Final: end the session
  await client.auth.signOut();
}

// ── Public board fetch (for ?board=<uuid> view mode) ────────────────
export async function sbLoadPublicBoard(client, boardId) {
  const { data: meta, error } = await client
    .from('boards').select('*').eq('id', boardId).single();
  if (error || !meta) throw new Error('Board not found');
  if (meta.visibility !== 'public') throw new Error('Board is private');

  const [{ data: notes }, { data: strokes }] = await Promise.all([
    client.from('notes').select('id,data').eq('board_id', boardId),
    client.from('strokes').select('data').eq('board_id', boardId).limit(1),
  ]);

  return {
    id: meta.id, name: meta.name,
    width:  Number(meta.width)  || 1366,
    height: Number(meta.height) || 768,
    panX: 0, panY: 0,
    notes:   (notes || []).map((r) => r.data),
    strokes: strokes?.length ? (strokes[0].data || []) : [],
    visibility: meta.visibility,
  };
}
