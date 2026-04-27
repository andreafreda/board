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

-- Deduplicate any pre-existing rows that share (board_id, owner_id) before
-- adding the UNIQUE constraint. Older versions stored one row per board
-- with id = board_id; subsequent code paths could create extras. Strategy:
-- keep the most recently updated row per group and merge every other row's
-- `data` array into it before deleting the rest.
with merged as (
  select s.board_id, s.owner_id,
         -- the surviving row id (most recently updated)
         (array_agg(s.id order by s.updated_at desc))[1] as keep_id,
         -- combined strokes from every duplicate row in the group
         (
           select coalesce(jsonb_agg(elem), '[]'::jsonb)
             from public.strokes s2,
                  lateral jsonb_array_elements(coalesce(s2.data, '[]'::jsonb)) elem
            where s2.board_id = s.board_id and s2.owner_id = s.owner_id
         ) as combined
    from public.strokes s
   group by s.board_id, s.owner_id
  having count(*) > 1
)
update public.strokes
   set data = merged.combined
  from merged
 where strokes.id = merged.keep_id;

delete from public.strokes s
 using (
   select id,
          row_number() over (partition by board_id, owner_id order by updated_at desc) as rn
     from public.strokes
 ) ranked
 where s.id = ranked.id and ranked.rn > 1;

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
--   SECURITY DEFINER helpers (break RLS recursion cycles)
-- ════════════════════════════════════════════════════════════════════
-- Without these, the policies create cycles like:
--   INSERT board_members → check members_insert_owner → SELECT boards
--     → check boards_select_cooperative_member → SELECT board_members
--     → check members_* → SELECT boards → … infinite recursion (42P17)
-- These helpers run as the function owner with RLS bypassed for the
-- single specific check, so the cycle is broken.

create or replace function public.is_board_owner(b_id uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.boards
     where id = b_id and owner_id = (select auth.uid())
  )
$$;

create or replace function public.is_board_member(b_id uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.board_members
     where board_id = b_id and email = (select auth.email())
  )
$$;

create or replace function public.is_board_editor(b_id uuid)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.board_members
     where board_id = b_id and email = (select auth.email()) and role = 'editor'
  )
$$;

create or replace function public.board_visibility(b_id uuid)
returns text language sql security definer stable
set search_path = public
as $$
  select visibility from public.boards where id = b_id
$$;

revoke all on function public.is_board_owner(uuid)    from public;
revoke all on function public.is_board_member(uuid)   from public;
revoke all on function public.is_board_editor(uuid)   from public;
revoke all on function public.board_visibility(uuid)  from public;
grant execute on function public.is_board_owner(uuid)    to authenticated, anon;
grant execute on function public.is_board_member(uuid)   to authenticated;
grant execute on function public.is_board_editor(uuid)   to authenticated;
grant execute on function public.board_visibility(uuid)  to authenticated, anon;

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

-- Cooperative boards: any authenticated user listed as member can SELECT.
-- Uses SECURITY DEFINER helper to avoid recursion with members_* policies.
create policy "boards_select_cooperative_member" on public.boards
  for select to authenticated using (
    visibility = 'cooperative' and public.is_board_member(id)
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
    public.board_visibility(board_id) = 'public'
  );

-- Cooperative members (any role) can SELECT notes on their cooperative boards
create policy "notes_select_cooperative_member" on public.notes
  for select to authenticated using (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_member(board_id)
  );

-- Board owner can SELECT/UPDATE/DELETE any note on their board (regardless
-- of who created it). Without this, editors' notes are invisible to the owner
-- because notes_select_own only matches auth.uid() = notes.owner_id.
create policy "notes_select_board_owner" on public.notes
  for select to authenticated using (public.is_board_owner(board_id));
create policy "notes_update_board_owner" on public.notes
  for update to authenticated
  using (public.is_board_owner(board_id))
  with check (public.is_board_owner(board_id));
create policy "notes_delete_board_owner" on public.notes
  for delete to authenticated using (public.is_board_owner(board_id));

-- Cooperative editors can INSERT/UPDATE/DELETE notes on cooperative boards
create policy "notes_insert_cooperative_editor" on public.notes
  for insert to authenticated with check (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_editor(board_id)
  );
create policy "notes_update_cooperative_editor" on public.notes
  for update to authenticated
  using (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_editor(board_id)
  )
  with check (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_editor(board_id)
  );
create policy "notes_delete_cooperative_editor" on public.notes
  for delete to authenticated using (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_editor(board_id)
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
    public.board_visibility(board_id) = 'public'
  );

create policy "strokes_select_cooperative_member" on public.strokes
  for select to authenticated using (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_member(board_id)
  );

-- Board owner can SELECT/UPDATE/DELETE any stroke row on their board (each
-- writer keeps their own row, but the owner needs to see them all).
create policy "strokes_select_board_owner" on public.strokes
  for select to authenticated using (public.is_board_owner(board_id));
create policy "strokes_update_board_owner" on public.strokes
  for update to authenticated
  using (public.is_board_owner(board_id))
  with check (public.is_board_owner(board_id));
create policy "strokes_delete_board_owner" on public.strokes
  for delete to authenticated using (public.is_board_owner(board_id));

create policy "strokes_insert_cooperative_editor" on public.strokes
  for insert to authenticated with check (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_editor(board_id)
  );
create policy "strokes_update_cooperative_editor" on public.strokes
  for update to authenticated
  using (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_editor(board_id)
  )
  with check (
    public.board_visibility(board_id) = 'cooperative'
    and public.is_board_editor(board_id)
  );

-- ── board_members ────────────────────────────────────────────────────
-- Owner manages all members of their boards. Uses is_board_owner() to
-- avoid recursion (would otherwise SELECT public.boards which triggers
-- the cooperative_member policy that selects from board_members).
create policy "members_select_owner" on public.board_members
  for select to authenticated using (public.is_board_owner(board_id));
create policy "members_insert_owner" on public.board_members
  for insert to authenticated with check (public.is_board_owner(board_id));
create policy "members_delete_owner" on public.board_members
  for delete to authenticated using (public.is_board_owner(board_id));
create policy "members_update_owner" on public.board_members
  for update to authenticated
  using (public.is_board_owner(board_id))
  with check (public.is_board_owner(board_id));

-- A member can read their own row (lets the client list invitations)
create policy "members_select_self" on public.board_members
  for select to authenticated using (email = (select auth.email()));

-- ════════════════════════════════════════════════════════════════════
--   Verify with:
--     select tablename, policyname from pg_policies
--      where schemaname='public'
--        and tablename in ('boards','notes','strokes','board_members')
--      order by tablename, policyname;
-- ════════════════════════════════════════════════════════════════════
