-- ============================================================================
-- NOVA OS — Phase 2: lead discovery
--
-- Adds the approved service catalog, an audit trail for every discovery run,
-- and the columns STERLING needs to score a business and recommend a service.
--
-- Deliberate constraint: a service cannot be enabled without a price. The
-- roadmap forbids inventing prices, so the catalog is seeded with real service
-- definitions and NO prices, disabled, until the owner sets them. Until then
-- scoring still runs; it just cannot recommend a priced service.
-- ============================================================================

create table if not exists public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]+$'),
  name text not null check (length(btrim(name)) > 0),
  description text not null check (length(btrim(description)) > 0),
  pricing_model text not null default 'fixed' check (pricing_model in ('fixed', 'range')),
  price_cents integer check (price_cents >= 0),
  min_price_cents integer check (min_price_cents >= 0),
  max_price_cents integer check (max_price_cents >= 0),
  cost_cents integer not null default 0 check (cost_cents >= 0),
  delivery_days integer not null default 7 check (delivery_days between 1 and 90),
  revisions integer not null default 1 check (revisions between 0 and 10),
  requirements text[] not null default '{}',
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_catalog_priced_when_enabled check (
    not enabled
    or (pricing_model = 'fixed' and price_cents is not null)
    or (
      pricing_model = 'range'
      and min_price_cents is not null
      and max_price_cents is not null
      and max_price_cents >= min_price_cents
    )
  )
);

create unique index if not exists service_catalog_owner_key_idx
  on public.service_catalog (owner_id, key);
create index if not exists service_catalog_enabled_idx
  on public.service_catalog (owner_id, enabled);

drop trigger if exists service_catalog_touch on public.service_catalog;
create trigger service_catalog_touch before update on public.service_catalog
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- discovery_runs — what was asked, what the provider returned, what we kept.
-- A run with zero inserts is recorded as such; nothing is inflated.
-- ---------------------------------------------------------------------------
create table if not exists public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid references public.agent_jobs (id) on delete set null,
  provider text not null default 'unconfigured',
  query text not null default '',
  industries text[] not null default '{}',
  geography text[] not null default '{}',
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'skipped')),
  found integer not null default 0 check (found >= 0),
  inserted integer not null default 0 check (inserted >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists discovery_runs_owner_recent_idx
  on public.discovery_runs (owner_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Leads: which catalog service STERLING recommends, and when it qualified.
-- `recommended_service` stays the human label; the key is the join.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists recommended_service_key text;
alter table public.leads
  add column if not exists qualified_at timestamptz;

create index if not exists leads_owner_score_idx
  on public.leads (owner_id, score desc nulls last);

-- ---------------------------------------------------------------------------
-- Seed the catalog. Definitions only — no prices, disabled by default.
-- ---------------------------------------------------------------------------
create or replace function public.seed_service_catalog(p_owner uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.service_catalog
    (owner_id, key, name, description, delivery_days, revisions, requirements)
  select
    p_owner,
    v.key,
    v.name,
    v.description,
    v.delivery_days,
    v.revisions,
    v.requirements
  from (values
    (
      'website_audit',
      'Website audit',
      'A written audit of a business website covering speed, mobile layout, clarity of the offer, basic SEO and conversion gaps, with a prioritised fix list.',
      2, 1,
      array['website url']::text[]
    ),
    (
      'landing_page',
      'Landing page',
      'A single-page site for one service or offer: copy, layout, mobile-first build and a clear enquiry action.',
      5, 2,
      array['business name', 'service to promote', 'contact details', 'logo or brand colours if any']::text[]
    ),
    (
      'google_business_profile',
      'Google Business Profile setup',
      'Set up or clean up a Google Business Profile: categories, service areas, hours, description, photo guidance and a review request link.',
      3, 1,
      array['business name', 'address or service area', 'phone', 'hours']::text[]
    ),
    (
      'content_starter',
      'Content starter pack',
      'A four-week content calendar plus eight publish-ready posts written for the business, its customers and its location.',
      5, 2,
      array['business name', 'audience', 'main offers', 'tone preferences']::text[]
    ),
    (
      'review_request_kit',
      'Review request kit',
      'Templates and a simple process for asking happy customers for Google reviews without breaking platform rules.',
      2, 1,
      array['business name', 'review link']::text[]
    ),
    (
      'enquiry_followup',
      'Enquiry follow-up sequence',
      'A three-email follow-up sequence for inbound enquiries, written in the business voice, with a scheduling recommendation.',
      4, 2,
      array['business name', 'what an enquiry looks like', 'response goal']::text[]
    )
  ) as v(key, name, description, delivery_days, revisions, requirements)
  on conflict (owner_id, key) do nothing;
$$;

revoke all on function public.seed_service_catalog(uuid) from public, anon, authenticated;

-- New owners get the catalog along with their settings row.
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

  perform public.seed_service_catalog(new.id);

  return new;
end;
$$;

-- Owners that existed before this migration.
do $$
declare
  owner_row record;
begin
  for owner_row in select owner_id from public.business_settings loop
    perform public.seed_service_catalog(owner_row.owner_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.service_catalog enable row level security;
alter table public.discovery_runs enable row level security;

drop policy if exists service_catalog_select on public.service_catalog;
create policy service_catalog_select on public.service_catalog
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists service_catalog_insert on public.service_catalog;
create policy service_catalog_insert on public.service_catalog
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists service_catalog_update on public.service_catalog;
create policy service_catalog_update on public.service_catalog
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists service_catalog_delete on public.service_catalog;
create policy service_catalog_delete on public.service_catalog
  for delete to authenticated using (owner_id = auth.uid());

drop policy if exists discovery_runs_select on public.discovery_runs;
create policy discovery_runs_select on public.discovery_runs
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.service_catalog from anon;
revoke all on public.discovery_runs from anon;

grant select, insert, update, delete on public.service_catalog to authenticated;
grant select on public.discovery_runs to authenticated;
