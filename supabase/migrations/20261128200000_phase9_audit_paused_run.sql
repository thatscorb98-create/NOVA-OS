-- ============================================================================
-- NOVA OS — Phase 9 follow-up: an owner-started dry-run audit runs while paused
--
-- A paused company defers non-system jobs, which also deferred `audit.run`: the
-- owner could not diagnose a paused company from the app because the audit never
-- executed. The audit is read-only and dry-run only, so it is safe to run while
-- paused — but only when the owner explicitly started it.
--
-- The job payload now carries `ownerStarted: true`. The worker honours the pause
-- exemption only for `audit.run` with that marker; anything else stays deferred.
-- ============================================================================

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
    jsonb_build_object('auditRunId', v_run.id, 'ownerStarted', true),
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
