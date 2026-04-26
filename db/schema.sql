-- ════════════════════════════════════════════════════════════════════
--   Board Lite — Unified DB Schema  (v1.5.0 — cooperative editing)
-- ════════════════════════════════════════════════════════════════════
--
-- Single, idempotent script. Run in:
--   Supabase Dashboard → SQL Editor → paste → Run
--
-- Sharing model:
--   • visibility = 'private'     → only owner can see/write
--   • visibility = 'public'      → anyone (incl. anon) can SELECT (read-only)
--   • visibility = 'cooperative' → owner + members can see; editors can write
--
-- Members are tracked by EMAIL (auth.email()), no claim/pending step —
-- access is immediate on the next login of the invited address.
-- Roles: 'editor' (read+write) or 'viewer' (read-only).
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── 1. Drop legacy artefacts ─────────────────────────────────────────
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('boards', 'notes', 'strokes', 'board_members')
  loop
    execute format('drop policy if exists %I on %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

-- ── 2. boards table ──────────────────────────────────────────────────
create table if not exists public.boards (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   uuid        not null references auth.users(id) on delete cascade,
  name       text        not null default 'Board',
  width      integer     not null default 1366,
  height     integer     not null default 768,
  visibility text        not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Refresh check constraint to allow 'cooperative'
alter table public.boards drop constraint if exists boards_visibility_check;
alter table public.boards
  add  constraint boards_visibility_check
  check (visibility in ('private', 'public', 'cooperative'));

alter table public.boards enable row level security;

-- ── 3. notes table ───────────────────────────────────────────────────
create table if not exists public.notes (
  id         uuid        primary key,
  board_id   uuid        not null references public.boards(id) on delete cascade,
  owner_id   uuid        not null references auth.users(id) on delete cascade,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.notes enable row level security;

-- ── 4. strokes table ─────────────────────────────────────────────────
-- For private/public boards: one row per board (deterministic upsert key).
-- For cooperative boards: still one row per board for now — last-write-wins
-- is acceptable until realtime sync adds per-user buffers (commit 2).
create table if not exists public.strokes (
  id         uuid        primary key default gen_random_uuid(),
  board_id   uuid        not null references public.boards(id) on delete cascade,
  owner_id   uuid        not null references auth.users(id) on delete cascade,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.strokes enable row level security;

-- Allow multiple stroke rows per board (one per writer) — cooperative editors
-- each maintain their own row to avoid last-write-wins overwriting one another.
alter table public.strokes drop constraint if exists strokes_board_owner_unique;
alter table public.strokes add  constraint strokes_board_owner_unique
  unique (board_id, owner_id);

-- ── 5. board_members table (email-based, no pending/claim) ──────────
create table if not exists public.board_members (
  board_id   uuid        not null references public.boards(id) on delete cascade,
  email      text        not null,
  role       text        not null default 'editor'
             check (role in ('editor', 'viewer')),
  added_at   timestamptz not null default now(),
  primary key (board_id, email)
);
alter table public.board_members enable row level security;

-- ── 6. Data hygiene (idempotent owner_id normalisation) ─────────────
update public.notes n
   set owner_id = b.owner_id
  from public.boards b
 where n.board_id = b.id and n.owner_id <> b.owner_id;

update public.strokes s
   set owner_id = b.owner_id
  from public.boards b
 where s.board_id = b.id and s.owner_id <> b.owner_id;

-- ════════════════════════════════════════════════════════════════════
--   Row-Level Security Policies
-- ════════════════════════════════════════════════════════════════════

-- ── boards ───────────────────────────────────────────────────────────
create policy "boards_select_own" on public.boards
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy "boards_insert_own" on public.boards
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "boards_update_own" on public.boards
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "boards_delete_own" on public.boards
  for delete to authenticated using ((select auth.uid()) = owner_id);

-- Public boards: anyone (incl. anon) can SELECT for the share-link reader
create policy "boards_select_public" on public.boards
  for select to anon, authenticated using (visibility = 'public');

-- Cooperative boards: any authenticated user listed as member can SELECT
create policy "boards_select_cooperative_member" on public.boards
  for select to authenticated using (
    visibility = 'cooperative'
    and exists (
      select 1 from public.board_members bm
       where bm.board_id = boards.id
         and bm.email    = (select auth.email())
    )
  );

-- ── notes ────────────────────────────────────────────────────────────
-- Owner full access (covers the user's own private/public/coop boards too)
create policy "notes_select_own" on public.notes
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy "notes_insert_own" on public.notes
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "notes_update_own" on public.notes
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "notes_delete_own" on public.notes
  for delete to authenticated using ((select auth.uid()) = owner_id);

-- Public-board notes are SELECT-able by anyone (view-mode read)
create policy "notes_select_public" on public.notes
  for select to anon, authenticated using (
    exists (select 1 from public.boards b
             where b.id = notes.board_id and b.visibility = 'public')
  );

-- Cooperative members (any role) can SELECT notes on their cooperative boards
create policy "notes_select_cooperative_member" on public.notes
  for select to authenticated using (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = notes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
    )
  );

-- Cooperative editors can INSERT/UPDATE/DELETE notes on cooperative boards
create policy "notes_insert_cooperative_editor" on public.notes
  for insert to authenticated with check (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = notes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
         and bm.role  = 'editor'
    )
  );
create policy "notes_update_cooperative_editor" on public.notes
  for update to authenticated using (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = notes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
         and bm.role  = 'editor'
    )
  ) with check (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = notes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
         and bm.role  = 'editor'
    )
  );
create policy "notes_delete_cooperative_editor" on public.notes
  for delete to authenticated using (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = notes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
         and bm.role  = 'editor'
    )
  );

-- ── strokes ──────────────────────────────────────────────────────────
create policy "strokes_select_own" on public.strokes
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy "strokes_insert_own" on public.strokes
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "strokes_update_own" on public.strokes
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "strokes_delete_own" on public.strokes
  for delete to authenticated using ((select auth.uid()) = owner_id);

create policy "strokes_select_public" on public.strokes
  for select to anon, authenticated using (
    exists (select 1 from public.boards b
             where b.id = strokes.board_id and b.visibility = 'public')
  );

create policy "strokes_select_cooperative_member" on public.strokes
  for select to authenticated using (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = strokes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
    )
  );

create policy "strokes_insert_cooperative_editor" on public.strokes
  for insert to authenticated with check (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = strokes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
         and bm.role  = 'editor'
    )
  );
create policy "strokes_update_cooperative_editor" on public.strokes
  for update to authenticated using (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = strokes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
         and bm.role  = 'editor'
    )
  ) with check (
    exists (
      select 1 from public.boards b
        join public.board_members bm on bm.board_id = b.id
       where b.id = strokes.board_id
         and b.visibility = 'cooperative'
         and bm.email = (select auth.email())
         and bm.role  = 'editor'
    )
  );

-- ── board_members ────────────────────────────────────────────────────
-- Owner manages all members of their boards
create policy "members_select_owner" on public.board_members
  for select to authenticated using (
    exists (select 1 from public.boards b
             where b.id = board_members.board_id and b.owner_id = (select auth.uid()))
  );
create policy "members_insert_owner" on public.board_members
  for insert to authenticated with check (
    exists (select 1 from public.boards b
             where b.id = board_members.board_id and b.owner_id = (select auth.uid()))
  );
create policy "members_delete_owner" on public.board_members
  for delete to authenticated using (
    exists (select 1 from public.boards b
             where b.id = board_members.board_id and b.owner_id = (select auth.uid()))
  );
create policy "members_update_owner" on public.board_members
  for update to authenticated
  using (
    exists (select 1 from public.boards b
             where b.id = board_members.board_id and b.owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.boards b
             where b.id = board_members.board_id and b.owner_id = (select auth.uid()))
  );

-- A member can read their own row (so the client can know which boards they're invited to)
create policy "members_select_self" on public.board_members
  for select to authenticated using (email = (select auth.email()));

-- ════════════════════════════════════════════════════════════════════
--   Verify with:
--     select tablename, policyname from pg_policies
--      where schemaname='public'
--        and tablename in ('boards','notes','strokes','board_members')
--      order by tablename, policyname;
-- ════════════════════════════════════════════════════════════════════
