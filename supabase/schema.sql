-- MacroChat database. Paste this whole file into Supabase: SQL Editor > New query > Run.

-- One row per person holding their food log, goals, profile and weigh-ins.
create table if not exists public.app_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_data enable row level security;

drop policy if exists "read own data" on public.app_data;
drop policy if exists "insert own data" on public.app_data;
drop policy if exists "update own data" on public.app_data;
drop policy if exists "delete own data" on public.app_data;

create policy "read own data" on public.app_data for select to authenticated using (auth.uid() = user_id);
create policy "insert own data" on public.app_data for insert to authenticated with check (auth.uid() = user_id);
create policy "update own data" on public.app_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own data" on public.app_data for delete to authenticated using (auth.uid() = user_id);

-- The server decides when a row changed, not the phone.
create or replace function public.touch_app_data() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists touch_app_data on public.app_data;
create trigger touch_app_data before insert or update on public.app_data
for each row execute function public.touch_app_data();

-- Counts AI requests per person per day. Only the AI function can touch it.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;  -- no policies: nobody but the server can read or write

create or replace function public.bump_ai_usage(p_user uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into public.ai_usage (user_id, day, count)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  returning count into c;
  return c;
end $$;

revoke all on function public.bump_ai_usage(uuid) from public, anon, authenticated;
