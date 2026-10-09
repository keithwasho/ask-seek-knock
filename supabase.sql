-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again: it only adds what is missing.

-- One row per counseling session: when it happened, what it cost, and whether it counts toward the monthly session limit.
create table if not exists public.usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Cost of each successful session in US dollars (used for the hidden monthly cost limit). Failed answers are not stored.
alter table public.usage add column if not exists cost_usd numeric(10, 5) not null default 0;
alter table public.usage add column if not exists counted boolean not null default true;

create index if not exists usage_user_created on public.usage (user_id, created_at);

-- Only the server (service role key) can read or write this table.
alter table public.usage enable row level security;
