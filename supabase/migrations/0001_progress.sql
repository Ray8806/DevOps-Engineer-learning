-- Learner progress: one row per user holding the whole Progress object
-- (src/lib/progress/progress.ts) as JSON. Run this once in the Supabase SQL editor.

create table if not exists public.progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Each signed-in user can only see and change their own row.
alter table public.progress enable row level security;

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
