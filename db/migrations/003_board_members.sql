-- Board Lite — F4 Board Members & Cooperative Access
-- Run after 002_board_visibility.sql

-- ── board_members table ───────────────────────────────────────
create table if not exists public.board_members (
  id         uuid        primary key default gen_random_uuid(),
  board_id   uuid        references public.boards(id) on delete cascade not null,
  owner_id   uuid        references auth.users(id) on delete cascade not null,
  user_id    uuid        references auth.users(id) on delete set null,
  email      text        not null,
  role       text        not null default 'editor'
             check (role in ('editor', 'viewer')),
  status     text        not null default 'pending'
             check (status in ('pending', 'active')),
  created_at timestamptz not null default now(),
  unique (board_id, email)
);

alter table public.board_members enable row level security;

-- Board owner can do anything with their board's members
create policy "members_all_owner"
on public.board_members
for all
to authenticated
using  ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

-- Active members can read their own record (to know their role)
create policy "members_select_self"
on public.board_members
for select
to authenticated
using ((select auth.uid()) = user_id and status = 'active');

-- ── Cooperative board access ──────────────────────────────────

-- Active members can SELECT cooperative boards they belong to
create policy "boards_select_cooperative_member"
on public.boards
for select
to authenticated
using (
  visibility = 'cooperative'
  and exists (
    select 1 from public.board_members bm
    where bm.board_id = boards.id
      and bm.user_id  = (select auth.uid())
      and bm.status   = 'active'
  )
);

-- Active members can SELECT notes on cooperative boards they belong to
create policy "notes_select_cooperative"
on public.notes
for select
to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = notes.board_id
      and bm.user_id  = (select auth.uid())
      and bm.status   = 'active'
  )
);

-- Active members can SELECT strokes on cooperative boards they belong to
create policy "strokes_select_cooperative"
on public.strokes
for select
to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = strokes.board_id
      and bm.user_id  = (select auth.uid())
      and bm.status   = 'active'
  )
);

-- ── Editor write access ───────────────────────────────────────
-- Editors can insert/update/delete notes on boards they have editor role on

create policy "notes_write_editor"
on public.notes
for all
to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = notes.board_id
      and bm.user_id  = (select auth.uid())
      and bm.role     = 'editor'
      and bm.status   = 'active'
  )
)
with check (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = notes.board_id
      and bm.user_id  = (select auth.uid())
      and bm.role     = 'editor'
      and bm.status   = 'active'
  )
);

create policy "strokes_write_editor"
on public.strokes
for all
to authenticated
using (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = strokes.board_id
      and bm.user_id  = (select auth.uid())
      and bm.role     = 'editor'
      and bm.status   = 'active'
  )
)
with check (
  exists (
    select 1 from public.board_members bm
    where bm.board_id = strokes.board_id
      and bm.user_id  = (select auth.uid())
      and bm.role     = 'editor'
      and bm.status   = 'active'
  )
);
