-- Board Lite v10 — Initial schema
-- Run once in Supabase SQL Editor
-- https://supabase.com/dashboard → SQL Editor

create extension if not exists pgcrypto;

-- ── boards ────────────────────────────────────────────────────
create table if not exists public.boards (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   uuid        references auth.users(id) on delete cascade not null,
  name       text        not null default 'Board',
  width      integer     not null default 1366,
  height     integer     not null default 768,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.boards enable row level security;

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

-- ── notes ─────────────────────────────────────────────────────
create table if not exists public.notes (
  id         uuid        primary key,
  board_id   uuid        references public.boards(id) on delete cascade not null,
  owner_id   uuid        references auth.users(id) on delete cascade not null,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notes enable row level security;

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

-- ── strokes ───────────────────────────────────────────────────
-- One row per board (id = board.id as deterministic upsert key).
create table if not exists public.strokes (
  id         uuid        primary key default gen_random_uuid(),
  board_id   uuid        references public.boards(id) on delete cascade not null,
  owner_id   uuid        references auth.users(id) on delete cascade not null,
  data       jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.strokes enable row level security;

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
