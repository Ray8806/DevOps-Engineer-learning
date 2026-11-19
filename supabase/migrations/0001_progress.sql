-- Learner progress: one row per user holding the whole Progress object
-- (src/lib/progress/progress.ts) as JSON. Run this in the Supabase SQL editor;
-- it can be run again safely.

create table if not exists public.progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Signed-in users may use the table at all (new projects do not grant this
-- automatically; without it requests fail with "permission denied for table
-- progress"). Visitors who are not signed in (anon) get nothing.
grant usage on schema public to authenticated;
grant select, insert, update on table public.progress to authenticated;

-- Each signed-in user can only see and change their own row.
alter table public.progress enable row level security;

drop policy if exists "Users read their own progress" on public.progress;
drop policy if exists "Users insert their own progress" on public.progress;
drop policy if exists "Users update their own progress" on public.progress;

create policy "Users read their own progress"
  on public.progress for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users insert their own progress"
  on public.progress for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users update their own progress"
  on public.progress for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
