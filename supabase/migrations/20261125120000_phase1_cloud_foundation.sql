-- ============================================================================
-- NOVA OS — Phase 1: cloud foundation
--
-- Adds the cloud side of NOVA OS on top of the existing local-first app:
--   * one owner row of business settings (company identity, caps, mode)
--   * company memory (the server-side ledger; agent memory is scope = 'agent')
--   * CRM foundation: leads, contacts, lead research evidence, deals
--   * a persistent agent job queue with retries, checkpoints and locks
--   * an append-only agent event log and worker heartbeats
--
-- Every table is owned by a single auth user and protected by row level
-- security. The phone's AsyncStorage workspace is untouched: this schema is
-- additive, so the app keeps working with no cloud configured.
--
-- No table stores credentials. The NVIDIA key stays in the device keystore and
-- provider/Stripe secrets belong in Edge Function secrets only.
-- ============================================================================

create extension if not exists pgcrypto;

do $$
begin
  create type public.autonomy_mode as enum
    ('paused', 'intelligence', 'outreach', 'sales', 'revenue', 'full');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.agent_job_status as enum
    ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest without trusting the client.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- business_settings — one row per owner.
--
-- Defaults are deliberately inert: the company starts paused, email, discovery,
-- production and live payments are all off. Nothing external can happen until
-- the owner turns a capability on after a phase has been tested.
-- ---------------------------------------------------------------------------
create table if not exists public.business_settings (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  company_name text not null default 'Local Reach Workshop',
  purpose text not null default
    'Help small businesses improve their online presence through practical digital services.',
  autonomy_mode public.autonomy_mode not null default 'paused',
  timezone text not null default 'UTC',

  -- Hard operating caps. Enforced by the worker, not just displayed in the UI.
  daily_lead_cap integer not null default 25 check (daily_lead_cap between 0 and 500),
  daily_email_cap integer not null default 20 check (daily_email_cap between 0 and 500),
  max_concurrency integer not null default 1 check (max_concurrency between 1 and 8),
  score_threshold integer not null default 60 check (score_threshold between 0 and 100),
  ai_budget_cents integer not null default 0 check (ai_budget_cents >= 0),
  ai_spend_cents integer not null default 0 check (ai_spend_cents >= 0),

  industries text[] not null default '{}',
  geography text[] not null default '{}',

  email_enabled boolean not null default false,
  discovery_enabled boolean not null default false,
  production_enabled boolean not null default false,
  payments_live boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- company_memory — the server-side ledger.
--
-- The roadmap lists both "company memory" and "agent_memory". They are one
-- ledger with a scope column: scope = 'agent' plus agent_id is agent memory.
-- Duplicate text in the same scope/owner is deduplicated by dedupe_hash.
-- ---------------------------------------------------------------------------
create table if not exists public.company_memory (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  scope text not null default 'company'
    check (scope in ('company', 'agent', 'project', 'customer')),
  agent_id text,
  -- Phone-local project ids are strings (prj_...), so this is text, not uuid.
  project_id text,
  kind text not null default 'note'
    check (kind in ('fact', 'preference', 'decision', 'summary', 'note')),
  source text not null default 'owner'
    check (source in ('owner', 'agent', 'nova', 'mission', 'conversation', 'local_sync', 'system')),
  text text not null check (length(btrim(text)) > 0),
  tags text[] not null default '{}',
  importance integer not null default 0 check (importance between 0 and 10),
  pinned boolean not null default false,
  dedupe_hash text generated always as (
    md5(
      lower(regexp_replace(text, '\s+', ' ', 'g'))
      || '|' || scope
      || '|' || coalesce(agent_id, '')
      || '|' || coalesce(project_id, '')
    )
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists company_memory_dedupe_idx
  on public.company_memory (owner_id, dedupe_hash);
create index if not exists company_memory_recent_idx
  on public.company_memory (owner_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- leads — CRM foundation. One row per real business, deduplicated by domain
-- (or by normalised name when no domain is known).
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  business_name text not null check (length(btrim(business_name)) > 0),
  website text,
  domain text,
  industry text,
  location text,
  source_kind text not null default 'search'
    check (source_kind in ('search', 'directory', 'referral', 'manual', 'social')),
  source_url text,
  status text not null default 'discovered'
    check (status in ('discovered', 'researched', 'qualified', 'rejected', 'archived')),
  score integer check (score between 0 and 100),
  score_breakdown jsonb not null default '{}'::jsonb,
  research_confidence numeric(4, 3) check (research_confidence between 0 and 1),
  recommended_service text,
  notes text,
  discovered_at timestamptz not null default now(),
  last_researched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists leads_owner_dedupe_idx
  on public.leads (owner_id, coalesce(domain, lower(btrim(business_name))));
create index if not exists leads_owner_status_idx
  on public.leads (owner_id, status, score desc);

-- ---------------------------------------------------------------------------
-- contacts — people at a lead. Email is normalised for dedupe and opt-out.
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  name text,
  role text,
  email text,
  email_normalized text,
  phone text,
  source_url text,
  verified boolean not null default false,
  opted_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists contacts_owner_email_idx
  on public.contacts (owner_id, email_normalized)
  where email_normalized is not null;
create index if not exists contacts_lead_idx on public.contacts (lead_id);

-- ---------------------------------------------------------------------------
-- lead_research — captured evidence. Every claim about a business must be
-- traceable to a source URL and a capture time.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_research (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  kind text not null default 'website'
    check (kind in ('website', 'search', 'social', 'directory', 'manual')),
  source_url text not null,
  title text,
  excerpt text,
  http_status integer,
  checksum text,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists lead_research_checksum_idx
  on public.lead_research (lead_id, checksum)
  where checksum is not null;
create index if not exists lead_research_lead_idx
  on public.lead_research (lead_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- deals — pipeline foundation. Stages match the roadmap exactly. Only one
-- open deal per lead is allowed, so a retried job cannot fork the pipeline.
-- ---------------------------------------------------------------------------
create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  stage text not null default 'discovered'
    check (stage in (
      'discovered', 'researched', 'qualified', 'contacted', 'replied', 'interested',
      'offer_prepared', 'negotiating', 'ready_to_purchase', 'won', 'lost', 'do_not_contact'
    )),
  service_key text,
  price_cents integer check (price_cents >= 0),
  currency text not null default 'usd',
  discount_cents integer not null default 0 check (discount_cents >= 0),
  scope text,
  next_action text,
  next_action_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists deals_open_per_lead_idx
  on public.deals (owner_id, lead_id)
  where stage not in ('won', 'lost', 'do_not_contact');
create index if not exists deals_owner_stage_idx
  on public.deals (owner_id, stage, next_action_at);

-- ---------------------------------------------------------------------------
-- agent_jobs — the persistent queue. Survives app restarts and closed phones.
--
-- attempts is incremented at claim time, so a worker that dies mid-job cannot
-- loop forever: requeue_stale_jobs() counts the attempt and eventually marks
-- the job dead. checkpoint lets a resumed job continue instead of restarting.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (length(btrim(kind)) > 0),
  payload jsonb not null default '{}'::jsonb,
  status public.agent_job_status not null default 'queued',
  priority integer not null default 100,
  run_after timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  idempotency_key text,
  locked_by text,
  locked_at timestamptz,
  locked_until timestamptz,
  checkpoint jsonb not null default '{}'::jsonb,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index if not exists agent_jobs_idempotency_idx
  on public.agent_jobs (owner_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists agent_jobs_claim_idx
  on public.agent_jobs (priority, run_after)
  where status = 'queued';
create index if not exists agent_jobs_owner_recent_idx
  on public.agent_jobs (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- agent_events — append-only activity log written by the worker.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid references public.agent_jobs (id) on delete set null,
  agent_id text,
  kind text not null,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_events_owner_recent_idx
  on public.agent_events (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- worker_heartbeats — proves a worker is alive independently of the phone.
-- ---------------------------------------------------------------------------
create table if not exists public.worker_heartbeats (
  worker_id text primary key,
  owner_id uuid references auth.users (id) on delete cascade,
  status text not null default 'idle' check (status in ('idle', 'working', 'error')),
  version text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists worker_heartbeats_owner_idx
  on public.worker_heartbeats (owner_id, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists business_settings_touch on public.business_settings;
create trigger business_settings_touch before update on public.business_settings
  for each row execute function public.set_updated_at();

drop trigger if exists company_memory_touch on public.company_memory;
create trigger company_memory_touch before update on public.company_memory
  for each row execute function public.set_updated_at();

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.set_updated_at();

drop trigger if exists contacts_touch on public.contacts;
create trigger contacts_touch before update on public.contacts
  for each row execute function public.set_updated_at();

drop trigger if exists deals_touch on public.deals;
create trigger deals_touch before update on public.deals
  for each row execute function public.set_updated_at();

drop trigger if exists agent_jobs_touch on public.agent_jobs;
create trigger agent_jobs_touch before update on public.agent_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- New owner bootstrap: settings row plus the permanent objective in company
-- memory, so the first thing NOVA reads is what the company is for.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.business_settings (owner_id)
  values (new.id)
  on conflict (owner_id) do nothing;

  insert into public.company_memory (owner_id, scope, kind, source, text, tags, pinned)
  values (
    new.id,
    'company',
    'decision',
    'owner',
    'Permanent objective: help small businesses improve their online presence through practical digital services, and earn legitimate sustainable profit through quality, honest, personalised work and reliable delivery. Never fabricate a business, a contact, a message, a payment or a deliverable.',
    array['objective', 'company', 'policy'],
    true
  )
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security. One owner per row, always. The service role bypasses RLS
-- inside edge functions; anon gets nothing at all.
-- ---------------------------------------------------------------------------
alter table public.business_settings enable row level security;
alter table public.company_memory enable row level security;
alter table public.leads enable row level security;
alter table public.contacts enable row level security;
alter table public.lead_research enable row level security;
alter table public.deals enable row level security;
alter table public.agent_jobs enable row level security;
alter table public.agent_events enable row level security;
alter table public.worker_heartbeats enable row level security;

-- business_settings: owner reads and updates, never deletes.
drop policy if exists business_settings_select on public.business_settings;
create policy business_settings_select on public.business_settings
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists business_settings_insert on public.business_settings;
create policy business_settings_insert on public.business_settings
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists business_settings_update on public.business_settings;
create policy business_settings_update on public.business_settings
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- company_memory: full owner control.
drop policy if exists company_memory_select on public.company_memory;
create policy company_memory_select on public.company_memory
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists company_memory_insert on public.company_memory;
create policy company_memory_insert on public.company_memory
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists company_memory_update on public.company_memory;
create policy company_memory_update on public.company_memory
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists company_memory_delete on public.company_memory;
create policy company_memory_delete on public.company_memory
  for delete to authenticated using (owner_id = auth.uid());

-- leads: full owner control.
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete to authenticated using (owner_id = auth.uid());

-- contacts: full owner control.
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts
  for delete to authenticated using (owner_id = auth.uid());

-- lead_research: evidence is append-only from the app's point of view.
drop policy if exists lead_research_select on public.lead_research;
create policy lead_research_select on public.lead_research
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists lead_research_insert on public.lead_research;
create policy lead_research_insert on public.lead_research
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists lead_research_delete on public.lead_research;
create policy lead_research_delete on public.lead_research
  for delete to authenticated using (owner_id = auth.uid());

-- deals: full owner control.
drop policy if exists deals_select on public.deals;
create policy deals_select on public.deals
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists deals_insert on public.deals;
create policy deals_insert on public.deals
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists deals_update on public.deals;
create policy deals_update on public.deals
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists deals_delete on public.deals;
create policy deals_delete on public.deals
  for delete to authenticated using (owner_id = auth.uid());

-- agent_jobs: the owner may read and enqueue work, but may never promote a job
-- to succeeded or rewrite its attempts. Status transitions belong to the worker
-- and to the cancel/release functions.
drop policy if exists agent_jobs_select on public.agent_jobs;
create policy agent_jobs_select on public.agent_jobs
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists agent_jobs_insert on public.agent_jobs;
create policy agent_jobs_insert on public.agent_jobs
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and status = 'queued'
    and attempts = 0
    and locked_by is null
  );

-- agent_events: owner reads; the app may append its own events.
drop policy if exists agent_events_select on public.agent_events;
create policy agent_events_select on public.agent_events
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists agent_events_insert on public.agent_events;
create policy agent_events_insert on public.agent_events
  for insert to authenticated with check (owner_id = auth.uid());

-- worker_heartbeats: read-only for the owner; only the service role writes.
drop policy if exists worker_heartbeats_select on public.worker_heartbeats;
create policy worker_heartbeats_select on public.worker_heartbeats
  for select to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Privileges: anon gets nothing, authenticated gets exactly what RLS allows.
-- ---------------------------------------------------------------------------
revoke all on public.business_settings from anon;
revoke all on public.company_memory from anon;
revoke all on public.leads from anon;
revoke all on public.contacts from anon;
revoke all on public.lead_research from anon;
revoke all on public.deals from anon;
revoke all on public.agent_jobs from anon;
revoke all on public.agent_events from anon;
revoke all on public.worker_heartbeats from anon;

grant select, insert, update on public.business_settings to authenticated;
grant select, insert, update, delete on public.company_memory to authenticated;
grant select, insert, update, delete on public.leads to authenticated;
grant select, insert, update, delete on public.contacts to authenticated;
grant select, insert, delete on public.lead_research to authenticated;
grant select, insert, update, delete on public.deals to authenticated;
grant select, insert on public.agent_jobs to authenticated;
grant select, insert on public.agent_events to authenticated;
grant select on public.worker_heartbeats to authenticated;

grant usage on sequence public.agent_events_id_seq to authenticated;
