-- Board Lite — Migration 008
-- Board owner can UPDATE/DELETE notes and strokes on their boards,
-- regardless of each row's owner_id.
--
-- WHY:
--   Migration 007 added SELECT policies for board owners, but UPDATE and DELETE
--   were still gated on owner_id = auth.uid() (migration 001 policies).
--   When a stale strokes/notes row has owner_id = guest_uuid, the board owner
--   cannot update it — the upsert silently saves 0 rows, losing the owner's work.
--
-- With v1.2.1, only the board owner writes strokes to DB (guests broadcast only),
-- but the owner still needs to be able to UPDATE an existing stale row.

-- ── Notes: board owner can UPDATE all notes on their boards ──
drop policy if exists "notes_update_board_owner" on public.notes;
create policy "notes_update_board_owner"
on public.notes
for update to authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = notes.board_id
      and b.owner_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.boards b
    where b.id = notes.board_id
      and b.owner_id = (select auth.uid())
  )
);

-- ── Strokes: board owner can UPDATE strokes on their boards ──
drop policy if exists "strokes_update_board_owner" on public.strokes;
create policy "strokes_update_board_owner"
on public.strokes
for update to authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = strokes.board_id
      and b.owner_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.boards b
    where b.id = strokes.board_id
      and b.owner_id = (select auth.uid())
  )
);

-- ── Strokes: board owner can DELETE strokes on their boards ──
drop policy if exists "strokes_delete_board_owner" on public.strokes;
create policy "strokes_delete_board_owner"
on public.strokes
for delete to authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = strokes.board_id
      and b.owner_id = (select auth.uid())
  )
);

-- ── Data fix: normalise owner_id on all notes/strokes rows ──
-- (idempotent — no-op if already correct)
update public.notes n
set    owner_id = b.owner_id
from   public.boards b
where  n.board_id = b.id
  and  n.owner_id <> b.owner_id;

update public.strokes s
set    owner_id = b.owner_id
from   public.boards b
where  s.board_id = b.id
  and  s.owner_id <> b.owner_id;
