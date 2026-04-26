-- Board Lite — Migration 007
-- Board owner can see (and delete) ALL notes/strokes on their boards,
-- regardless of each row's owner_id.
--
-- WHY:
--   Before v.1.1.9, doSbSave() upserted notes/strokes with
--   owner_id = currentUser.id (the guest's UUID).
--   The board owner's notes_all_owner policy (owner_id = auth.uid()) then
--   couldn't SELECT those rows → post-its disappeared for the owner.
--   v.1.1.9 fixed the write path, but existing rows in the DB still have
--   the wrong owner_id and need:
--     a) new SELECT/DELETE policies so the owner can see them now
--     b) a one-time data fix to normalise owner_id going forward

-- ── 1. Board owner: SELECT all notes on boards they own ──────────
drop policy if exists "notes_select_board_owner" on public.notes;
create policy "notes_select_board_owner"
on public.notes
for select to authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = notes.board_id
      and b.owner_id = (select auth.uid())
  )
);

-- ── 2. Board owner: DELETE all notes on boards they own ──────────
drop policy if exists "notes_delete_board_owner" on public.notes;
create policy "notes_delete_board_owner"
on public.notes
for delete to authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = notes.board_id
      and b.owner_id = (select auth.uid())
  )
);

-- ── 3. Board owner: SELECT all strokes on boards they own ────────
drop policy if exists "strokes_select_board_owner" on public.strokes;
create policy "strokes_select_board_owner"
on public.strokes
for select to authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = strokes.board_id
      and b.owner_id = (select auth.uid())
  )
);

-- ── 4. One-time data fix: normalise owner_id on existing rows ────
-- Set notes.owner_id = board's owner_id wherever they diverged.
-- Safe to run multiple times (no-op if already correct).
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
