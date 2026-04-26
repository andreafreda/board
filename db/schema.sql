-- ════════════════════════════════════════════════════════════════════
--   Board Lite — Unified DB Schema  (v1.3.4)
-- ════════════════════════════════════════════════════════════════════
--
-- Single, idempotent script that brings a Supabase project to the exact
-- state required by index.html (v1.3.4). Run it in:
--   Supabase Dashboard → SQL Editor → paste → Run
--
-- It is SAFE to run on:
--   • a brand-new project (creates everything from scratch)
--   • an old project (drops legacy artefacts: board_members table,
--     cooperative-editing policies, redundant board-owner overrides)
--
-- The app uses ONLY:
--   • boards   — one row per user board (private or public)
--   • notes    — one row per post-it
--   • strokes  — one row per board (whole stroke array as jsonb)
--
-- Sharing model:
--   • visibility = 'private' → only owner can see/write
--   • visibility = 'public'  → anyone (incl. anon) can SELECT (read-only)
--   • Cooperative editing (F4) was removed — board_members is dropped.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── 1. Drop legacy artefacts (safe if absent) ────────────────────────
drop table if exists public.board_members cascade;

-- Drop every policy we might have created in past migrations so we can
-- re-create the canonical set below. Each `drop policy if exists` is a
-- no-op if the policy isn't there.
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('boards', 'notes', 'strokes')
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      pol.policyname, pol.schemaname, pol.tablename
    );
  end loop;
end $$;

-- ── 2. boards table ──────────────────────────────────────────────────
create table if not exists public.boards (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   uuid        not null references auth.users(id) on delete cascade,
  name       text        not null default 'Board',
  width      integer     not null default 1366,
  height     integer     not null default 768,
  visibility text        not null default 'private'
             check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- If migrating from a project that had visibility = 'cooperative',
-- normalise those rows back to 'private' (cooperative is gone).
update public.boards set visibility = 'private' where visibility not in ('private','public');

-- Re-add the constraint if an older 3-value version was in place.
alter table public.boards drop constraint if exists boards_visibility_check;
alter table public.boards
  add  constraint boards_visibility_check
  check (visibility in ('private', 'public'));

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
-- One row per board (id = board.id is the deterministic upsert key).
create table if not exists public.strokes (
  id         uuid        primary key default gen_random_uuid(),
  board_id   uuid        not null references public.boards(id) on delete cascade,
  owner_id   uuid        not null references auth.users(id) on delete cascade,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.strokes enable row level security;

-- ── 5. Data hygiene: notes/strokes always owned by the board owner ──
-- (Old cooperative builds let guests write rows with their own uuid,
--  which now breaks UPDATE/DELETE policies. Idempotent fix.)
update public.notes n
   set owner_id = b.owner_id
  from public.boards b
 where n.board_id = b.id
   and n.owner_id <> b.owner_id;

update public.strokes s
   set owner_id = b.owner_id
  from public.boards b
 where s.board_id = b.id
   and s.owner_id <> b.owner_id;

-- ════════════════════════════════════════════════════════════════════
--   Row-Level Security Policies
-- ════════════════════════════════════════════════════════════════════

-- ── boards ───────────────────────────────────────────────────────────
-- Owner full access
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

-- Public boards: anyone (incl. anon) can SELECT — that's how the
-- ?board=<uuid> share link works for non-logged-in viewers.
create policy "boards_select_public" on public.boards
  for select to anon, authenticated using (visibility = 'public');

-- ── notes ────────────────────────────────────────────────────────────
-- Owner full access
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
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.boards b
       where b.id = notes.board_id
         and b.visibility = 'public'
    )
  );

-- ── strokes ──────────────────────────────────────────────────────────
-- Owner full access
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

-- Public-board strokes are SELECT-able by anyone (view-mode read)
create policy "strokes_select_public" on public.strokes
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.boards b
       where b.id = strokes.board_id
         and b.visibility = 'public'
    )
  );

-- ════════════════════════════════════════════════════════════════════
--   Done. Verify with:
--     select tablename, policyname from pg_policies
--      where schemaname='public' and tablename in ('boards','notes','strokes')
--      order by tablename, policyname;
-- ════════════════════════════════════════════════════════════════════
