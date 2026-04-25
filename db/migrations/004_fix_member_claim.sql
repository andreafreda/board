-- Board Lite — F4 fix: allow invited users to activate their own pending invite
-- Run after 003_board_members.sql
--
-- Problem: members_all_owner (FOR ALL, using owner_id = auth.uid()) blocks the
-- invited user from updating their own board_members row when they log in.
-- claimPendingMemberships() silently updates 0 rows because RLS rejects the write.
--
-- Fix: add a narrow UPDATE policy using auth.email() (Supabase built-in) instead
-- of a subquery on auth.users (which authenticated role cannot access directly).
-- PostgreSQL evaluates ALL policy USING clauses before OR-ing them, so even a
-- policy that ultimately doesn't apply can cause "permission denied for table users"
-- if it queries auth.users directly.

-- Idempotent: drop first so this file can be re-run safely
drop policy if exists "members_claim_self" on public.board_members;

create policy "members_claim_self"
on public.board_members
for update
to authenticated
using (
  -- Row must still be pending and the invite email must match the caller's auth email
  status = 'pending'
  and email = auth.email()
)
with check (
  -- After the update: row must point to the caller and be active
  user_id = (select auth.uid())
  and status = 'active'
);
