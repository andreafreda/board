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
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

// ════════════════════════════════════════════════════════════════════
//   Board / notes / strokes — owner-scoped CRUD
// ════════════════════════════════════════════════════════════════════
//
// IMPORTANT: every SELECT for the user's own boards filters by owner_id.
// RLS *also* allows SELECT on visibility='public' rows, so a bare
// select('*') would leak public boards from other users into the list.

export async function sbLoadBoards(client, ownerId) {
  if (!ownerId) return null;
  const { data: boards } = await client
    .from('boards')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at');
  if (!boards?.length) return null;

  // Hydrate notes + strokes for every board in parallel
  return Promise.all(boards.map(async (b) => {
    const [{ data: notes }, { data: strokes }] = await Promise.all([
      client.from('notes').select('id,data').eq('board_id', b.id),
      client.from('strokes').select('data').eq('board_id', b.id).limit(1),
    ]);
    return {
      id: b.id,
      name: b.name,
      width:  Number(b.width)  || 1366,
      height: Number(b.height) || 768,
      visibility: b.visibility || 'private',
      panX: 0, panY: 0,
      notes:   (notes || []).map((r) => r.data),
      strokes: strokes?.length ? (strokes[0].data || []) : [],
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

// ── doSbSave: persist the active board + its notes + strokes row ────
export async function sbSaveActiveBoard(client, ownerId, board) {
  if (!ownerId || !board) return;
  const ts = new Date().toISOString();

  await client.from('boards').upsert({
    id: board.id, owner_id: ownerId,
    name: board.name, width: board.width, height: board.height,
    visibility: board.visibility || 'private',
    updated_at: ts,
  });

  if (board.notes.length > 0) {
    await client.from('notes').upsert(
      board.notes.map((n) => ({
        id: n.id, board_id: board.id, owner_id: ownerId,
        data: n, updated_at: ts,
      })),
    );
  }

  // Delete notes that the client has removed from this board
  const { data: existing } = await client.from('notes').select('id').eq('board_id', board.id);
  const curIds = new Set(board.notes.map((n) => n.id));
  const toDelete = (existing || []).map((r) => r.id).filter((id) => !curIds.has(id));
  if (toDelete.length) await client.from('notes').delete().in('id', toDelete);

  // One strokes row per board (id = board.id is the upsert key)
  await client.from('strokes').upsert({
    id: board.id, board_id: board.id, owner_id: ownerId,
    data: board.strokes, updated_at: ts,
  });
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
