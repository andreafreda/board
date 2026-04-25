-- Board Lite — F4 fix: allow invited users to activate their own pending invite
-- Run after 003_board_members.sql
--
-- Problem: members_all_owner (FOR ALL, using owner_id = auth.uid()) blocks the
-- invited user from updating their own board_members row when they log in.
-- claimPendingMemberships() silently updates 0 rows because RLS rejects the write.
--
-- Fix: add a narrow UPDATE policy that lets an authenticated user flip exactly
-- their own pending row (matched by email) from pending → active.

create policy "members_claim_self"
on public.board_members
for update
to authenticated
using (
  -- The row must still be pending and the invite email must match the caller's auth email
  status = 'pending'
  and email = (
    select au.email
    from auth.users au
    where au.id = (select auth.uid())
  )
)
with check (
  -- After the update the row must point to the caller and be active
  user_id = (select auth.uid())
  and status = 'active'
);
