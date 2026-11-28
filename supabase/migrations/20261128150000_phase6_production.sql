-- ============================================================================
-- NOVA OS — Phase 6: production studio
--
-- A paid order becomes production work. The job keeps the brief it was created
-- from, every generated version, the files that were actually uploaded, and
-- SENTINEL's verdict on each version. A job cannot be marked ready by the app:
-- only `sentinel.qa` writes a pass, after checking stored files.
--
-- Files live in the private `deliverables` bucket under
--   <owner_id>/<job_id>/v<version>/<name>
-- The owner may read their own folder; only the service role uploads.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- production_jobs — one job per paid order.
-- ---------------------------------------------------------------------------
create table if not exists public.production_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  order_id uuid not null unique references public.orders (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  deliverable_id uuid references public.deliverables (id) on delete set null,
  service_key text,
  title text not null check (length(btrim(title)) > 0),
  brief jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'generating', 'qa', 'ready', 'needs_attention', 'delivered', 'cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  version integer not null default 0 check (version >= 0),
  qa_notes text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_attempts_within_limit check (attempts <= max_attempts)
);

create index if not exists production_jobs_owner_status_idx
  on public.production_jobs (owner_id, status, created_at desc);

drop trigger if exists production_jobs_touch on public.production_jobs;
create trigger production_jobs_touch before update on public.production_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- production_files — the evidence that a file was created and stored.
-- ---------------------------------------------------------------------------
create table if not exists public.production_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.production_jobs (id) on delete cascade,
  version integer not null check (version >= 1),
  name text not null check (length(btrim(name)) > 0),
  storage_path text not null,
  mime text not null,
  bytes integer not null check (bytes > 0),
  sha256 text not null check (length(sha256) = 64),
  kind text not null default 'primary'
    check (kind in ('primary', 'preview', 'asset')),
  created_at timestamptz not null default now(),
  constraint production_files_path_unique unique (storage_path),
  constraint production_files_name_unique unique (job_id, version, name)
);

create index if not exists production_files_job_idx
  on public.production_files (job_id, version, created_at);

-- ---------------------------------------------------------------------------
-- production_qa — SENTINEL's verdict, stored per version.
-- ---------------------------------------------------------------------------
create table if not exists public.production_qa (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.production_jobs (id) on delete cascade,
  version integer not null check (version >= 1),
  verdict text not null check (verdict in ('pass', 'fail')),
  checks jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists production_qa_job_idx
  on public.production_qa (job_id, created_at desc);

-- ---------------------------------------------------------------------------
-- A paid order creates its production job automatically.
--
-- The job always exists, so the Studio can show a paid order even when
-- production is switched off. The worker job is enqueued only when the owner
-- has armed production; `start_production` arms a single job later.
-- ---------------------------------------------------------------------------
create or replace function public.create_production_job_for_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_lead public.leads;
  v_settings public.business_settings;
  v_contact_email text;
  v_job public.production_jobs;
begin
  select * into v_quote from public.quotes where id = new.quote_id;
  if v_quote.id is null then
    return new;
  end if;

  select * into v_lead from public.leads where id = new.lead_id;

  select c.email_normalized
    into v_contact_email
  from public.contacts c
  where c.owner_id = new.owner_id
    and c.lead_id = new.lead_id
    and c.opted_out = false
  order by c.created_at asc
  limit 1;

  insert into public.production_jobs (
    owner_id, order_id, quote_id, service_key, title, brief
  )
  values (
    new.owner_id,
    new.id,
    new.quote_id,
    v_quote.service_key,
    v_quote.title,
    jsonb_build_object(
      'businessName', v_lead.business_name,
      'website', v_lead.website,
      'location', v_lead.location,
      'industry', v_lead.industry,
      'contactEmail', v_contact_email,
      'serviceKey', v_quote.service_key,
      'scope', v_quote.scope,
      'deliverables', v_quote.deliverables,
      'terms', v_quote.terms,
      'requirements', to_jsonb(v_quote.requirements)
    )
  )
  on conflict (order_id) do nothing
  returning * into v_job;

  if v_job.id is not null then
    select * into v_settings
    from public.business_settings
    where owner_id = new.owner_id;

    if coalesce(v_settings.production_enabled, false) then
      perform public.enqueue_agent_job(
        'forge.produce',
        jsonb_build_object('jobId', v_job.id),
        'forge:' || v_job.id::text || ':v0',
        now(),
        50,
        new.owner_id
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_create_production on public.orders;
create trigger orders_create_production
  after insert on public.orders
  for each row execute function public.create_production_job_for_order();

-- ---------------------------------------------------------------------------
-- start_production — the owner arms one queued job.
--
-- The enqueue key is version-based, so a double tap cannot queue two FORGE runs
-- for the same version. A retry after a failed QA increments the version first.
-- ---------------------------------------------------------------------------
create or replace function public.start_production(p_job_id uuid)
returns public.production_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_job public.production_jobs;
  v_enabled boolean;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  select * into v_job
  from public.production_jobs
  where id = p_job_id and owner_id = v_owner
  for update;

  if v_job.id is null then
    raise exception 'unknown production job';
  end if;

  if v_job.status not in ('queued', 'needs_attention') then
    raise exception 'production job is already %', v_job.status;
  end if;

  select production_enabled into v_enabled
  from public.business_settings
  where owner_id = v_owner;

  if not coalesce(v_enabled, false) then
    raise exception 'production is switched off';
  end if;

  update public.production_jobs
  set status = 'generating',
      started_at = coalesce(started_at, now()),
      qa_notes = null
  where id = p_job_id
  returning * into v_job;

  perform public.enqueue_agent_job(
    'forge.produce',
    jsonb_build_object('jobId', p_job_id),
    'forge:' || p_job_id::text || ':v' || v_job.version::text,
    now(),
    50,
    v_owner
  );

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.production_jobs enable row level security;
alter table public.production_files enable row level security;
alter table public.production_qa enable row level security;

drop policy if exists production_jobs_select on public.production_jobs;
create policy production_jobs_select on public.production_jobs
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists production_files_select on public.production_files;
create policy production_files_select on public.production_files
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists production_qa_select on public.production_qa;
create policy production_qa_select on public.production_qa
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.production_jobs from anon, authenticated;
revoke all on public.production_files from anon, authenticated;
revoke all on public.production_qa from anon, authenticated;

grant select on public.production_jobs to authenticated;
grant select on public.production_files to authenticated;
grant select on public.production_qa to authenticated;

-- The worker uses the service role directly to write files, QA and job state.
grant all on public.production_jobs to service_role;
grant all on public.production_files to service_role;
grant all on public.production_qa to service_role;
grant usage, select on sequence public.production_qa_id_seq to service_role;

revoke all on function public.start_production(uuid) from public, anon;
grant execute on function public.start_production(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, owner-scoped reads, service-role writes.
-- Guarded so the plain-Postgres migration suite (which has no storage schema)
-- still applies cleanly.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('deliverables', 'deliverables', false)
    on conflict (id) do nothing;
  end if;
end $$;

do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists deliverables_owner_select on storage.objects';
    execute 'create policy deliverables_owner_select on storage.objects for select to authenticated using (bucket_id = ''deliverables'' and (storage.foldername(name))[1] = auth.uid()::text)';
  end if;
end $$;
