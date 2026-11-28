-- ============================================================================
-- NOVA OS — Phase 9: audit and dry-run
--
-- A Phase 9 audit is a persisted, owner-scoped report produced by the worker.
-- It is deliberately dry-run only:
--
--   * `dry_run` is constrained to true. There is no code path for a live audit.
--   * the audit handler performs reads only; it never sends, charges, produces,
--     discovers, researches or writes customer records.
--   * test scenarios run against a throwaway local Postgres, not this project's
--     real rows (see docs/phase-9-audit.md).
--
-- The report distinguishes three outcomes: pass, fail and blocked. `blocked`
-- means the check could not be completed because a provider or configuration is
-- missing — it is never reported as a pass.
-- ============================================================================

create table if not exists public.audit_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid references public.agent_jobs (id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'passed', 'failed', 'blocked')),
  -- Phase 9 has no live audit. A row that claims otherwise cannot exist.
  dry_run boolean not null default true check (dry_run = true),
  checks jsonb not null default '[]'::jsonb
    check (jsonb_typeof(checks) = 'array'),
  summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(summary) = 'object'),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists audit_runs_owner_recent_idx
  on public.audit_runs (owner_id, created_at desc);

alter table public.audit_runs enable row level security;

drop policy if exists audit_runs_select on public.audit_runs;
create policy audit_runs_select on public.audit_runs
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.audit_runs from anon, authenticated;
grant select on public.audit_runs to authenticated;
grant all on public.audit_runs to service_role;

-- ---------------------------------------------------------------------------
-- start_audit_run — the owner asks for one dry-run audit.
--
-- The function creates the report row and queues `audit.run`. A second request
-- while one is queued or running is refused rather than piling up jobs. There is
-- no parameter that can start a live audit.
-- ---------------------------------------------------------------------------
create or replace function public.start_audit_run(p_dry_run boolean default true)
returns public.audit_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.audit_runs;
  v_job public.agent_jobs;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  if p_dry_run is not true then
    raise exception 'Phase 9 audits are dry-run only; no live audit exists';
  end if;

  -- If the worker exhausted its attempts, the report can never finish. Release
  -- the owner from that dead job instead of blocking every future audit.
  update public.audit_runs ar
  set status = 'failed',
      finished_at = now(),
      updated_at = now(),
      summary = ar.summary || jsonb_build_object(
        'error', 'the audit job ended without a report'
      )
  from public.agent_jobs job
  where ar.owner_id = v_owner
    and ar.status in ('queued', 'running')
    and ar.job_id = job.id
    and job.status in ('failed', 'dead', 'cancelled');

  if exists (
    select 1 from public.audit_runs
    where owner_id = v_owner and status in ('queued', 'running')
  ) then
    raise exception 'a dry-run audit is already queued or running';
  end if;

  insert into public.audit_runs (owner_id, status, dry_run)
  values (v_owner, 'queued', true)
  returning * into v_run;

  select * into v_job
  from public.enqueue_agent_job(
    'audit.run',
    jsonb_build_object('auditRunId', v_run.id),
    'audit:' || v_run.id::text,
    now(),
    60,
    v_owner
  );

  update public.audit_runs
  set job_id = v_job.id, updated_at = now()
  where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_audit_check — worker only.
--
-- One check per key. Repeating a key replaces its latest result, so a retried
-- handler does not append the same check twice.
-- ---------------------------------------------------------------------------
create or replace function public.record_audit_check(
  p_run_id uuid,
  p_key text,
  p_status text,
  p_detail text default null,
  p_data jsonb default '{}'::jsonb
)
returns public.audit_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.audit_runs;
  v_key text := left(btrim(coalesce(p_key, '')), 80);
  v_checks jsonb;
begin
  if not public.is_service_request() then
    raise exception 'audit checks are recorded by the worker only';
  end if;

  if p_status not in ('pass', 'fail', 'blocked') then
    raise exception 'unknown audit check status "%"', p_status;
  end if;

  if v_key = '' then
    raise exception 'an audit check needs a key';
  end if;

  select * into v_run from public.audit_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'that audit run does not exist';
  end if;
  if v_run.status not in ('queued', 'running') then
    raise exception 'audit run is already finished';
  end if;

  -- Drop an earlier result for this key, then append the latest one.
  select coalesce(jsonb_agg(entry), '[]'::jsonb)
  into v_checks
  from jsonb_array_elements(v_run.checks) entry
  where entry ->> 'key' is distinct from v_key;

  v_checks := v_checks || jsonb_build_array(
    jsonb_build_object(
      'key', v_key,
      'status', p_status,
      'detail', left(coalesce(nullif(btrim(p_detail), ''), ''), 600),
      'data', coalesce(p_data, '{}'::jsonb),
      'at', now()
    )
  );

  update public.audit_runs
  set checks = v_checks,
      status = 'running',
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = p_run_id
  returning * into v_run;

  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- finish_audit_run — worker only. The outcome is derived from the checks, not
-- supplied by the caller: one fail means failed, a blocked check means blocked.
-- ---------------------------------------------------------------------------
create or replace function public.finish_audit_run(
  p_run_id uuid,
  p_summary jsonb default '{}'::jsonb
)
returns public.audit_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.audit_runs;
  v_passed integer;
  v_failed integer;
  v_blocked integer;
  v_status text;
begin
  if not public.is_service_request() then
    raise exception 'audit runs are finished by the worker only';
  end if;

  select * into v_run from public.audit_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'that audit run does not exist';
  end if;
  if v_run.status not in ('queued', 'running') then
    return v_run;
  end if;

  select
    count(*) filter (where entry ->> 'status' = 'pass')::int,
    count(*) filter (where entry ->> 'status' = 'fail')::int,
    count(*) filter (where entry ->> 'status' = 'blocked')::int
  into v_passed, v_failed, v_blocked
  from jsonb_array_elements(v_run.checks) entry;

  v_status := case
    when v_failed > 0 then 'failed'
    when v_blocked > 0 then 'blocked'
    else 'passed'
  end;

  update public.audit_runs
  set status = v_status,
      finished_at = now(),
      updated_at = now(),
      summary = coalesce(p_summary, '{}'::jsonb) || jsonb_build_object(
        'checks', jsonb_array_length(v_run.checks),
        'passed', v_passed,
        'failed', v_failed,
        'blocked', v_blocked
      )
  where id = p_run_id
  returning * into v_run;

  insert into public.agent_events (owner_id, job_id, kind, level, message, data)
  values (
    v_run.owner_id,
    v_run.job_id,
    'audit.run',
    case when v_status = 'failed' then 'warn' else 'info' end,
    case v_status
      when 'passed' then 'Dry-run audit passed every check.'
      when 'blocked' then 'Dry-run audit finished with blocked checks; see the report.'
      else 'Dry-run audit found failures; see the report.'
    end,
    jsonb_build_object('auditRunId', v_run.id, 'status', v_status,
                       'passed', v_passed, 'failed', v_failed, 'blocked', v_blocked)
  );

  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- audit_database — read-only evidence for the handler.
--
-- Service-role only. Returns schema/security findings and owner invariants as
-- jsonb so the handler can turn each one into a check without trusting a count
-- typed on the phone. It writes nothing.
-- ---------------------------------------------------------------------------
create or replace function public.audit_database(p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.business_settings;
begin
  if not public.is_service_request() then
    raise exception 'the database audit runs in the worker only';
  end if;

  if p_owner_id is null then
    raise exception 'an audit needs an owner';
  end if;

  select * into v_settings
  from public.business_settings
  where owner_id = p_owner_id;

  if v_settings.owner_id is null then
    raise exception 'no business settings exist for this owner';
  end if;

  return jsonb_build_object(
    'tablesWithoutRls', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not c.relrowsecurity
    ),
    'anonTableGrants', (
      select coalesce(jsonb_agg(g.table_name order by g.table_name), '[]'::jsonb)
      from information_schema.role_table_grants g
      where g.table_schema = 'public'
        and g.grantee = 'anon'
    ),
    'definerWithoutSearchPath', (
      select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and not exists (
          select 1
          from unnest(coalesce(p.proconfig, '{}'::text[])) setting
          where setting like 'search_path=%'
        )
    ),
    'anonExecutableDefiners', (
      select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        -- Trigger functions are invoked by the trigger machinery, not by a
        -- caller; they cannot be executed directly through the API.
        and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('anon', p.oid, 'execute')
    ),
    'succeededWithoutProviderRef', (
      select count(*)::int from public.payment_intents
      where owner_id = p_owner_id
        and status = 'succeeded'
        and provider_ref is null
    ),
    'ordersWithoutConfirmedPayment', (
      select count(*)::int
      from public.orders o
      where o.owner_id = p_owner_id
        and not exists (
          select 1 from public.payment_intents pi
          where pi.id = o.payment_intent_id
            and pi.owner_id = o.owner_id
            and pi.status in ('succeeded', 'refunded', 'partially_refunded')
        )
    ),
    'ordersWithAmountMismatch', (
      select count(*)::int
      from public.orders o
      join public.payment_intents pi on pi.id = o.payment_intent_id
      where o.owner_id = p_owner_id
        and (o.amount_cents <> pi.amount_cents or o.currency <> pi.currency)
    ),
    'deliveredWithoutAcceptedQuote', (
      select count(*)::int
      from public.deliverables d
      join public.quotes q on q.id = d.quote_id
      where d.owner_id = p_owner_id
        and d.status in ('delivered', 'accepted')
        and q.status <> 'accepted'
    ),
    'deliveredWithoutMessage', (
      select count(*)::int
      from public.deliverables d
      where d.owner_id = p_owner_id
        and d.status in ('delivered', 'accepted')
        and d.delivery_message_id is null
    ),
    'productionWithoutPaidOrder', (
      select count(*)::int
      from public.production_jobs pj
      join public.orders o on o.id = pj.order_id
      where pj.owner_id = p_owner_id
        and o.status not in ('paid', 'fulfilled', 'refunded', 'partially_refunded')
    ),
    'sentWithoutProviderRef', (
      select count(*)::int
      from public.outreach_messages
      where owner_id = p_owner_id
        and status = 'sent'
        and provider_message_id is null
    ),
    'staleRunningJobs', (
      select count(*)::int
      from public.agent_jobs
      where owner_id = p_owner_id
        and status = 'running'
        and locked_until is not null
        and locked_until < now()
    ),
    'settings', jsonb_build_object(
      'mode', v_settings.autonomy_mode,
      'emailEnabled', v_settings.email_enabled,
      'discoveryEnabled', v_settings.discovery_enabled,
      'productionEnabled', v_settings.production_enabled,
      'paymentsLive', v_settings.payments_live,
      'stripeLiveMode', v_settings.stripe_live_mode,
      'aiBudgetCents', v_settings.ai_budget_cents,
      'aiSpendCents', v_settings.ai_spend_cents,
      'aiOverspent', v_settings.ai_spend_cents > v_settings.ai_budget_cents
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function public.start_audit_run(boolean) from public, anon;
grant execute on function public.start_audit_run(boolean) to authenticated, service_role;

revoke all on function public.record_audit_check(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_audit_check(uuid, text, text, text, jsonb) to service_role;

revoke all on function public.finish_audit_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finish_audit_run(uuid, jsonb) to service_role;

revoke all on function public.audit_database(uuid) from public, anon, authenticated;
grant execute on function public.audit_database(uuid) to service_role;
