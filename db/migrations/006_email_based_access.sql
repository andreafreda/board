-- Board Lite — simplify cooperative access: email-based, no pending/claiming
-- Run after 005 (or after 004 if 005 was never applied)
--
-- Old model: invite creates a pending row, invited user must "claim" it on login
--            to set user_id and flip status to active. Many moving parts, many bugs.
--
-- New model: access is granted by email match (auth.email()) directly.
--            No status field, no user_id needed, no claim step.
--            Board is immediately visible to the invited user on their next login.

-- ── Drop old policies ─────────────────────────────────────
drop policy if exists "boards_select_cooperative_member" on public.boards;
drop policy if exists "notes_select_cooperative"         on public.notes;
drop policy if exists "strokes_select_cooperative"       on public.strokes;
drop policy if exists "notes_write_editor"               on public.notes;
drop policy if exists "strokes_write_editor"             on public.strokes;
drop policy if exists "members_select_self"              on public.board_members;
drop policy if exists "members_select_pending_self"      on public.board_members;
drop policy if exists "members_claim_self"               on public.board_members;

-- ── New email-based policies ──────────────────────────────

-- Active members can SELECT cooperative boards they belong to (by email)
create policy "boards_select_cooperative_member"
on public.boards
for select to authenticated
using (
  visibility = 'cooperative'
  and exists (
    select 1 from public.board_members bm
    where bm.board_id = boards.id
      and bm.email    = auth.email()
  )
);

-- Members can SELECT notes on cooperative boards (by email)
create policy "notes_select_cooperative"
on public.notes
for select to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = notes.board_id
      and bm.email    = auth.email()
  )
);

-- Members can SELECT strokes on cooperative boards (by email)
create policy "strokes_select_cooperative"
on public.strokes
for select to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = strokes.board_id
      and bm.email    = auth.email()
  )
);

-- Editors can write notes (by email + role)
create policy "notes_write_editor"
on public.notes
for all to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = notes.board_id
      and bm.email    = auth.email()
      and bm.role     = 'editor'
  )
)
with check (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = notes.board_id
      and bm.email    = auth.email()
      and bm.role     = 'editor'
  )
);

-- Editors can write strokes (by email + role)
create policy "strokes_write_editor"
on public.strokes
for all to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = strokes.board_id
      and bm.email    = auth.email()
      and bm.role     = 'editor'
  )
)
with check (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = strokes.board_id
      and bm.email    = auth.email()
      and bm.role     = 'editor'
  )
);

-- Members can read their own board_members record (by email)
create policy "members_select_self"
on public.board_members
for select to authenticated
using (email = auth.email());
