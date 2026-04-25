-- Board Lite — F3 Board Visibility
-- Run after 001_initial_schema.sql

-- ── Add visibility column to boards ──────────────────────────
alter table public.boards
  add column if not exists visibility text not null default 'private'
  check (visibility in ('private', 'public', 'cooperative'));

-- ── Open public boards to anonymous read ─────────────────────
-- boards: anyone can SELECT rows where visibility = 'public'
create policy "boards_select_public"
on public.boards
for select
to anon, authenticated
using (visibility = 'public');

-- notes: anyone can SELECT notes belonging to a public board
create policy "notes_select_public"
on public.notes
for select
to anon, authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = notes.board_id
      and b.visibility = 'public'
  )
);

-- strokes: same for strokes
create policy "strokes_select_public"
on public.strokes
for select
to anon, authenticated
using (
  exists (
    select 1 from public.boards b
    where b.id = strokes.board_id
      and b.visibility = 'public'
  )
);

-- ── Notes ────────────────────────────────────────────────────
-- No write policies for anon: only the owner can mutate (already covered by 001).
-- Cooperative write will be added in 003_board_members.sql (F4).
