-- ============================================================================
-- NOVA OS — Phase 1: queue, health and sync functions
--
-- The queue is claimed with FOR UPDATE SKIP LOCKED so several workers can run
-- safely. Worker-only functions are granted to service_role alone; the app can
-- enqueue, cancel, read health and import its local memory, nothing more.
-- ============================================================================

-- True when the request arrived with the service-role key.
create or replace function public.is_service_request()
returns boolean
language sql
stable
as $$
  select coalesce(auth.role(), '') = 'service_role';
$$;

-- ---------------------------------------------------------------------------
-- enqueue_agent_job — idempotent by (owner_id, idempotency_key).
--
-- Re-enqueueing the same key returns the existing job untouched, so a retried
-- app action or a duplicated cron tick cannot create duplicate work.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_agent_job(
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_run_after timestamptz default now(),
  p_priority integer default 100,
  p_owner_id uuid default null
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
  v_job public.agent_jobs;
begin
  if v_owner is null then
    raise exception 'enqueue_agent_job needs a signed-in owner';
  end if;

  if not public.is_service_request() and v_owner <> auth.uid() then
    raise exception 'not allowed to enqueue work for another owner';
  end if;

  if p_kind is null or length(btrim(p_kind)) = 0 then
    raise exception 'enqueue_agent_job needs a job kind';
  end if;

  insert into public.agent_jobs (owner_id, kind, payload, run_after, priority, idempotency_key)
  values (v_owner, btrim(p_kind), coalesce(p_payload, '{}'::jsonb), coalesce(p_run_after, now()),
          coalesce(p_priority, 100), nullif(btrim(coalesce(p_idempotency_key, '')), ''))
  on conflict (owner_id, idempotency_key) where idempotency_key is not null
  do update set updated_at = now()
  returning * into v_job;

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_agent_jobs — worker only. Locks rows for five minutes and counts the
-- attempt at claim time so a dead worker cannot retry forever.
-- ---------------------------------------------------------------------------
create or replace function public.claim_agent_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_owner_id uuid default null
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or length(btrim(p_worker_id)) = 0 then
    raise exception 'claim_agent_jobs needs a worker id';
  end if;

  return query
  with picked as (
    select id
    from public.agent_jobs
    where status = 'queued'
      and run_after <= now()
      and (p_owner_id is null or owner_id = p_owner_id)
    order by priority asc, run_after asc, created_at asc
    limit greatest(1, least(coalesce(p_limit, 1), 10))
    for update skip locked
  )
  update public.agent_jobs job
  set status = 'running',
      attempts = job.attempts + 1,
      locked_by = p_worker_id,
      locked_at = now(),
      locked_until = now() + interval '5 minutes',
      updated_at = now()
  from picked
  where job.id = picked.id
  returning job.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_agent_job
-- ---------------------------------------------------------------------------
create or replace function public.complete_agent_job(
  p_job_id uuid,
  p_result jsonb default '{}'::jsonb
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.agent_jobs;
begin
  update public.agent_jobs
  set status = 'succeeded',
      result = coalesce(p_result, '{}'::jsonb),
      last_error = null,
      locked_by = null,
      locked_at = null,
      locked_until = null,
      finished_at = now(),
      updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- fail_agent_job — retries with exponential backoff, then goes dead.
-- ---------------------------------------------------------------------------
create or replace function public.fail_agent_job(
  p_job_id uuid,
  p_error text,
  p_retry_after interval default null
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.agent_jobs;
  v_dead boolean;
  v_delay interval;
begin
  select * into v_job from public.agent_jobs where id = p_job_id for update;

  if not found then
    return null;
  end if;

  v_dead := v_job.attempts >= v_job.max_attempts;
  v_delay := coalesce(
    p_retry_after,
    make_interval(secs => least(300, (power(2, v_job.attempts) * 5)::int))
  );

  update public.agent_jobs
  set status = case when v_dead then 'dead'::public.agent_job_status
                    else 'queued'::public.agent_job_status end,
      last_error = left(coalesce(p_error, 'Unknown failure.'), 2000),
      locked_by = null,
      locked_at = null,
      locked_until = null,
      run_after = case when v_dead then run_after else now() + v_delay end,
      finished_at = case when v_dead then now() else null end,
      updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- release_agent_job — put a claimed job back without spending an attempt.
-- Used when the company is paused: the work is deferred, not failed.
-- ---------------------------------------------------------------------------
create or replace function public.release_agent_job(
  p_job_id uuid,
  p_delay interval default interval '10 minutes',
  p_reason text default null
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.agent_jobs;
begin
  update public.agent_jobs
  set status = 'queued',
      attempts = greatest(attempts - 1, 0),
      locked_by = null,
      locked_at = null,
      locked_until = null,
      run_after = now() + coalesce(p_delay, interval '10 minutes'),
      last_error = left(coalesce(p_reason, last_error), 2000),
      updated_at = now()
  where id = p_job_id
    and status = 'running'
  returning * into v_job;

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- checkpoint_agent_job — persist partial progress so a resumed job continues.
-- ---------------------------------------------------------------------------
create or replace function public.checkpoint_agent_job(
  p_job_id uuid,
  p_checkpoint jsonb
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.agent_jobs;
begin
  update public.agent_jobs
  set checkpoint = coalesce(p_checkpoint, '{}'::jsonb),
      locked_until = now() + interval '5 minutes',
      updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- requeue_stale_jobs — recovery for workers that died mid-job.
-- ---------------------------------------------------------------------------
create or replace function public.requeue_stale_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with stale as (
    select id
    from public.agent_jobs
    where status = 'running'
      and locked_until is not null
      and locked_until < now()
    for update skip locked
  )
  update public.agent_jobs job
  set status = case when job.attempts >= job.max_attempts
                    then 'dead'::public.agent_job_status
                    else 'queued'::public.agent_job_status end,
      last_error = coalesce(job.last_error, 'The worker lock expired before this job finished.'),
      locked_by = null,
      locked_at = null,
      locked_until = null,
      finished_at = case when job.attempts >= job.max_attempts then now() else null end,
      run_after = case when job.attempts >= job.max_attempts then job.run_after else now() end,
      updated_at = now()
  from stale
  where job.id = stale.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_agent_job — owner-scoped, cannot touch another owner's work.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_agent_job(p_job_id uuid)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_job public.agent_jobs;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  update public.agent_jobs
  set status = 'cancelled',
      locked_by = null,
      locked_at = null,
      locked_until = null,
      finished_at = now(),
      updated_at = now()
  where id = p_job_id
    and owner_id = v_owner
    and status in ('queued', 'running')
  returning * into v_job;

  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- heartbeat_worker — the scheduler and worker both report liveness here.
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat_worker(
  p_worker_id text,
  p_status text default 'idle',
  p_version text default null,
  p_owner_id uuid default null
)
returns public.worker_heartbeats
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.worker_heartbeats;
begin
  insert into public.worker_heartbeats (worker_id, owner_id, status, version, last_seen_at)
  values (
    p_worker_id,
    p_owner_id,
    case when p_status in ('idle', 'working', 'error') then p_status else 'idle' end,
    p_version,
    now()
  )
  on conflict (worker_id) do update
    set status = excluded.status,
        version = coalesce(excluded.version, public.worker_heartbeats.version),
        owner_id = coalesce(excluded.owner_id, public.worker_heartbeats.owner_id),
        last_seen_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- business_health — one call that powers the app's cloud indicators.
-- ---------------------------------------------------------------------------
create or replace function public.business_health()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_queue jsonb;
  v_worker jsonb;
  v_settings jsonb;
  v_counts jsonb;
begin
  if v_owner is null then
    return jsonb_build_object('ok', false, 'error', 'sign in required');
  end if;

  select jsonb_build_object(
           'queued', count(*) filter (where status = 'queued'),
           'running', count(*) filter (where status = 'running'),
           'failed', count(*) filter (where status = 'failed'),
           'dead', count(*) filter (where status = 'dead'),
           'succeeded24h', count(*) filter (
             where status = 'succeeded' and finished_at > now() - interval '24 hours'
           )
         )
  into v_queue
  from public.agent_jobs
  where owner_id = v_owner;

  select to_jsonb(h)
  into v_worker
  from (
    select worker_id,
           status,
           version,
           last_seen_at,
           (now() - last_seen_at) < interval '2 minutes' as alive
    from public.worker_heartbeats
    where owner_id = v_owner
    order by last_seen_at desc
    limit 1
  ) h;

  select to_jsonb(s)
  into v_settings
  from (
    select autonomy_mode,
           company_name,
           daily_lead_cap,
           daily_email_cap,
           max_concurrency,
           score_threshold,
           ai_budget_cents,
           ai_spend_cents,
           email_enabled,
           discovery_enabled,
           production_enabled,
           payments_live,
           updated_at
    from public.business_settings
    where owner_id = v_owner
  ) s;

  select jsonb_build_object(
           'leads', (select count(*) from public.leads where owner_id = v_owner),
           'deals', (select count(*) from public.deals where owner_id = v_owner),
           'memories', (select count(*) from public.company_memory where owner_id = v_owner),
           'events24h', (
             select count(*) from public.agent_events
             where owner_id = v_owner and created_at > now() - interval '24 hours'
           )
         )
  into v_counts;

  return jsonb_build_object(
    'ok', true,
    'owner_id', v_owner,
    'phase', 'phase1',
    'queue', coalesce(v_queue, '{}'::jsonb),
    'worker', v_worker,
    'settings', v_settings,
    'counts', coalesce(v_counts, '{}'::jsonb),
    'checked_at', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_local_snapshot — import the phone's memory ledger into company memory.
--
-- Additive and idempotent: the phone keeps its data, duplicates are skipped by
-- dedupe_hash, and conversation summaries are filed under agent scope. The
-- payload is capped so a bad client cannot flood the ledger.
-- ---------------------------------------------------------------------------
create or replace function public.sync_local_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_item jsonb;
  v_scope text;
  v_kind text;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_rows integer;
  v_seen integer := 0;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_payload -> 'memories', '[]'::jsonb))
  loop
    v_seen := v_seen + 1;
    exit when v_seen > 500;

    v_scope := case v_item ->> 'scope'
      when 'project' then 'project'
      when 'agent' then 'agent'
      when 'conversation' then 'agent'
      else 'company'
    end;

    v_kind := case
      when v_item ->> 'kind' in ('fact', 'preference', 'decision', 'summary', 'note')
        then v_item ->> 'kind'
      else 'note'
    end;

    insert into public.company_memory
      (owner_id, scope, agent_id, project_id, kind, source, text, tags, pinned)
    values (
      v_owner,
      v_scope,
      nullif(v_item ->> 'agentId', ''),
      nullif(v_item ->> 'projectId', ''),
      v_kind,
      'local_sync',
      left(coalesce(v_item ->> 'text', ''), 1200),
      coalesce(
        (
          select array_agg(tag)
          from jsonb_array_elements_text(coalesce(v_item -> 'tags', '[]'::jsonb)) as t(tag)
        ),
        '{}'
      ),
      case when (v_item ->> 'pinned') = 'true' then true else false end
    )
    on conflict (owner_id, dedupe_hash) do nothing;

    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      v_inserted := v_inserted + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'skipped', v_skipped,
    'received', least(v_seen, 500)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges.
-- ---------------------------------------------------------------------------
revoke all on function public.is_service_request() from public, anon, authenticated;
grant execute on function public.is_service_request() to service_role;

revoke all on function public.enqueue_agent_job(text, jsonb, text, timestamptz, integer, uuid)
  from public, anon;
grant execute on function public.enqueue_agent_job(text, jsonb, text, timestamptz, integer, uuid)
  to authenticated, service_role;

revoke all on function public.cancel_agent_job(uuid) from public, anon;
grant execute on function public.cancel_agent_job(uuid) to authenticated, service_role;

revoke all on function public.business_health() from public, anon;
grant execute on function public.business_health() to authenticated, service_role;

revoke all on function public.sync_local_snapshot(jsonb) from public, anon;
grant execute on function public.sync_local_snapshot(jsonb) to authenticated, service_role;

-- Worker-only surface: no app session may claim, complete or fail a job.
revoke all on function public.claim_agent_jobs(text, integer, uuid) from public, anon, authenticated;
revoke all on function public.complete_agent_job(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_agent_job(uuid, text, interval) from public, anon, authenticated;
revoke all on function public.release_agent_job(uuid, interval, text) from public, anon, authenticated;
revoke all on function public.checkpoint_agent_job(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.requeue_stale_jobs() from public, anon, authenticated;
revoke all on function public.heartbeat_worker(text, text, text, uuid) from public, anon, authenticated;

grant execute on function public.claim_agent_jobs(text, integer, uuid) to service_role;
grant execute on function public.complete_agent_job(uuid, jsonb) to service_role;
grant execute on function public.fail_agent_job(uuid, text, interval) to service_role;
grant execute on function public.release_agent_job(uuid, interval, text) to service_role;
grant execute on function public.checkpoint_agent_job(uuid, jsonb) to service_role;
grant execute on function public.requeue_stale_jobs() to service_role;
grant execute on function public.heartbeat_worker(text, text, text, uuid) to service_role;
