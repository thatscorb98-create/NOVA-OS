-- ============================================================================
-- NOVA OS — Phase 8: autonomous company loop
--
-- The loop is a queued job, `nova.orchestrate`, run by the scheduler. It reads a
-- single owner-scoped snapshot, chooses one next action, enqueues it with an
-- idempotency key, and records the decision. It never sends, charges, produces
-- or delivers anything itself: every action still passes the gates built in
-- Phases 2–7.
--
-- Two things are deliberately absent from the loop:
--   * payments and checkouts — a payment record needs the customer's explicit
--     acceptance, and a checkout is created by the owner after that
--   * any purchase or service upgrade — the loop has no code path that spends
--     money, and `record_ai_spend` refuses to cross the owner's AI budget
--
-- `company_cycles` is the loop's own checkpoint trail: one row per scheduled
-- cycle, unique per owner and cycle key, so a repeated cron tick cannot record
-- or enqueue duplicate work.
-- ============================================================================

create table if not exists public.company_cycles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  cycle_key text not null check (length(btrim(cycle_key)) between 1 and 120),
  status text not null default 'idle'
    check (status in ('action', 'idle', 'paused', 'blocked', 'error')),
  decision text not null default 'none' check (length(btrim(decision)) between 1 and 80),
  detail jsonb not null default '{}'::jsonb,
  job_id uuid references public.agent_jobs (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists company_cycles_key_idx
  on public.company_cycles (owner_id, cycle_key);

create index if not exists company_cycles_owner_idx
  on public.company_cycles (owner_id, created_at desc);

alter table public.company_cycles enable row level security;

drop policy if exists company_cycles_select on public.company_cycles;
create policy company_cycles_select on public.company_cycles
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.company_cycles from anon, authenticated;
grant select on public.company_cycles to authenticated;
grant all on public.company_cycles to service_role;

-- ---------------------------------------------------------------------------
-- nova_loop_snapshot — everything the loop needs to choose one action.
--
-- SECURITY DEFINER, but every count filters owner_id = auth.uid(). The `next`
-- object carries the id of the specific row the loop would act on, so the
-- handler does not need to trust a count and then re-query a different row.
-- ---------------------------------------------------------------------------
create or replace function public.nova_loop_snapshot(p_owner_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
  v_settings public.business_settings;
  v_counts jsonb;
  v_next jsonb;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  -- The worker calls this with the service role, where auth.uid() is null. An
  -- app session may only ask for its own owner id.
  if not public.is_service_request() and v_owner <> auth.uid() then
    raise exception 'not allowed to read another owner company';
  end if;

  select * into v_settings
  from public.business_settings
  where owner_id = v_owner;

  if v_settings.owner_id is null then
    raise exception 'no business settings exist for this owner yet';
  end if;

  select jsonb_build_object(
    'leadsTotal', (
      select count(*)::int from public.leads
      where owner_id = v_owner
    ),
    'leadsQualified', (
      select count(*)::int from public.leads
      where owner_id = v_owner and status = 'qualified'
    ),
    'leadsToday', (
      select count(*)::int from public.leads
      where owner_id = v_owner and discovered_at >= date_trunc('day', now())
    ),
    'discoveryToday', (
      -- Any discovery attempt today, from the loop or from the app. It marks
      -- the day as spent so an empty or failed search is not queued again on
      -- every scheduler tick.
      select count(*)::int from public.agent_jobs
      where owner_id = v_owner
        and kind = 'atlas.discover'
        and created_at >= date_trunc('day', now())
    ),
    'leadsWithoutOutreach', (
      select count(*)::int
      from public.leads l
      where l.owner_id = v_owner
        and l.status = 'qualified'
        and exists (
          select 1 from public.contacts c
          where c.owner_id = l.owner_id and c.lead_id = l.id and c.opted_out = false
        )
        and not exists (
          select 1 from public.outreach_messages m
          where m.owner_id = l.owner_id and m.lead_id = l.id
        )
    ),
    'draftsPending', (
      select count(*)::int from public.outreach_messages
      where owner_id = v_owner and status = 'draft'
    ),
    'approvedReady', (
      select count(*)::int from public.outreach_messages
      where owner_id = v_owner and status = 'approved'
    ),
    'dueFollowUps', (
      select count(*)::int from public.follow_ups
      where owner_id = v_owner and status = 'scheduled' and due_at <= now()
    ),
    'repliesUndrafted', (
      select count(*)::int
      from public.email_events e
      where e.owner_id = v_owner
        and e.kind = 'replied'
        and e.intent is distinct from 'unsubscribe'
        and not exists (
          select 1 from public.outreach_messages m
          where m.owner_id = e.owner_id
            and m.idempotency_key = 'reply:' || e.id::text
        )
    ),
    'dealsReady', (
      select count(*)::int from public.deals
      where owner_id = v_owner and stage = 'ready_to_purchase'
    ),
    'productionQueued', (
      select count(*)::int
      from public.production_jobs pj
      where pj.owner_id = v_owner
        and pj.status = 'queued'
        -- An existing forge/QA job already owns this queued work. Counting it
        -- again would let the loop enqueue a second generator for the same
        -- version, so only genuinely unqueued jobs are actionable.
        and not exists (
          select 1 from public.agent_jobs aj
          where aj.owner_id = pj.owner_id
            and aj.kind in ('forge.produce', 'sentinel.qa')
            and aj.status in ('queued', 'running')
            and aj.payload ->> 'jobId' = pj.id::text
        )
    ),
    'productionReady', (
      select count(*)::int from public.production_jobs
      where owner_id = v_owner and status = 'ready'
    ),
    'deliveriesUnsent', (
      select count(*)::int
      from public.production_jobs pj
      join public.deliverables d
        on d.owner_id = pj.owner_id and d.quote_id = pj.quote_id
      where pj.owner_id = v_owner
        and pj.status = 'ready'
        and d.status in ('pending', 'in_progress', 'revision_requested')
    ),
    'deliveredWithoutPlan', (
      select count(*)::int
      from public.deliverables d
      where d.owner_id = v_owner
        and d.status = 'delivered'
        and d.delivery_message_id is not null
        -- Never re-plan someone who replied or bounced, and never recreate a
        -- plan the owner cancelled: any existing row of these kinds means the
        -- plan was already offered once.
        and not exists (
          select 1 from public.follow_ups f
          where f.owner_id = d.owner_id
            and f.message_id = d.delivery_message_id
            and f.kind in ('receipt', 'review', 'recurring')
        )
        and not exists (
          select 1 from public.email_events e
          where e.owner_id = d.owner_id
            and e.message_id = d.delivery_message_id
            and e.kind in ('replied', 'bounced')
        )
    ),
    'jobsQueued', (
      select count(*)::int from public.agent_jobs
      where owner_id = v_owner and status = 'queued'
    ),
    'jobsDead', (
      select count(*)::int from public.agent_jobs
      where owner_id = v_owner and status = 'dead'
    ),
    'ordersPaid', (
      select count(*)::int from public.orders
      where owner_id = v_owner and status in ('paid', 'fulfilled')
    )
  ) into v_counts;

  select jsonb_build_object(
    'followUpId', (
      select f.id from public.follow_ups f
      where f.owner_id = v_owner and f.status = 'scheduled' and f.due_at <= now()
      order by f.due_at asc, f.created_at asc
      limit 1
    ),
    'replyEventId', (
      select e.id
      from public.email_events e
      where e.owner_id = v_owner
        and e.kind = 'replied'
        and e.intent is distinct from 'unsubscribe'
        and not exists (
          select 1 from public.outreach_messages m
          where m.owner_id = e.owner_id
            and m.idempotency_key = 'reply:' || e.id::text
        )
      order by e.id asc
      limit 1
    ),
    'production', (
      select jsonb_build_object('jobId', pj.id, 'version', pj.version)
      from public.production_jobs pj
      where pj.owner_id = v_owner
        and pj.status = 'queued'
        and not exists (
          select 1 from public.agent_jobs aj
          where aj.owner_id = pj.owner_id
            and aj.kind in ('forge.produce', 'sentinel.qa')
            and aj.status in ('queued', 'running')
            and aj.payload ->> 'jobId' = pj.id::text
        )
      order by pj.created_at asc
      limit 1
    ),
    'delivery', (
      select jsonb_build_object('jobId', pj.id, 'deliverableId', d.id)
      from public.production_jobs pj
      join public.deliverables d
        on d.owner_id = pj.owner_id and d.quote_id = pj.quote_id
      where pj.owner_id = v_owner
        and pj.status = 'ready'
        and d.status in ('pending', 'in_progress', 'revision_requested')
      order by pj.created_at desc
      limit 1
    ),
    'approvedMessageId', (
      select m.id from public.outreach_messages m
      where m.owner_id = v_owner and m.status = 'approved'
      order by m.created_at asc
      limit 1
    ),
    'leadId', (
      select l.id
      from public.leads l
      where l.owner_id = v_owner
        and l.status = 'qualified'
        and exists (
          select 1 from public.contacts c
          where c.owner_id = l.owner_id and c.lead_id = l.id and c.opted_out = false
        )
        and not exists (
          select 1 from public.outreach_messages m
          where m.owner_id = l.owner_id and m.lead_id = l.id
        )
      order by l.score desc nulls last, l.created_at asc
      limit 1
    ),
    'deliveredMessageId', (
      select d.delivery_message_id
      from public.deliverables d
      where d.owner_id = v_owner
        and d.status = 'delivered'
        and d.delivery_message_id is not null
        and not exists (
          select 1 from public.follow_ups f
          where f.owner_id = d.owner_id
            and f.message_id = d.delivery_message_id
            and f.kind in ('receipt', 'review', 'recurring')
        )
        and not exists (
          select 1 from public.email_events e
          where e.owner_id = d.owner_id
            and e.message_id = d.delivery_message_id
            and e.kind in ('replied', 'bounced')
        )
      order by d.delivered_at desc nulls last
      limit 1
    )
  ) into v_next;

  return jsonb_build_object(
    'mode', v_settings.autonomy_mode,
    'emailEnabled', v_settings.email_enabled,
    'discoveryEnabled', v_settings.discovery_enabled,
    'productionEnabled', v_settings.production_enabled,
    'dailyLeadCap', v_settings.daily_lead_cap,
    'dailyEmailCap', v_settings.daily_email_cap,
    'aiBudgetCents', v_settings.ai_budget_cents,
    'aiSpendCents', v_settings.ai_spend_cents,
    'aiRemainingCents', greatest(0, v_settings.ai_budget_cents - v_settings.ai_spend_cents),
    'counts', v_counts,
    'next', v_next,
    'serverTime', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- record_company_cycle — the loop's checkpoint row.
--
-- Service-role only. A repeated cycle key returns the first row instead of
-- writing a second, so a duplicated scheduler tick leaves one record.
-- ---------------------------------------------------------------------------
create or replace function public.record_company_cycle(
  p_owner_id uuid,
  p_cycle_key text,
  p_status text,
  p_decision text,
  p_detail jsonb default '{}'::jsonb,
  p_job_id uuid default null
)
returns public.company_cycles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.company_cycles;
begin
  if not public.is_service_request() then
    raise exception 'company cycles are recorded by the worker only';
  end if;

  if p_owner_id is null then
    raise exception 'a company cycle needs an owner';
  end if;

  if p_status not in ('action', 'idle', 'paused', 'blocked', 'error') then
    raise exception 'unknown cycle status "%"', p_status;
  end if;

  if p_cycle_key is null or length(btrim(p_cycle_key)) = 0 then
    raise exception 'a company cycle needs a key';
  end if;

  insert into public.company_cycles (owner_id, cycle_key, status, decision, detail, job_id)
  values (
    p_owner_id,
    left(btrim(p_cycle_key), 120),
    p_status,
    left(coalesce(nullif(btrim(p_decision), ''), 'none'), 80),
    coalesce(p_detail, '{}'::jsonb),
    p_job_id
  )
  on conflict (owner_id, cycle_key) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row
    from public.company_cycles
    where owner_id = p_owner_id and cycle_key = left(btrim(p_cycle_key), 120);
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_ai_spend — a hard cap, not a display value.
--
-- Nothing in the current worker calls a paid model, so this function is not on
-- the hot path yet. It exists so that when a model-backed handler is added it
-- has exactly one way to account for cost, and that way refuses to cross the
-- owner's budget. A budget of zero means no paid AI spend at all.
-- ---------------------------------------------------------------------------
create or replace function public.record_ai_spend(
  p_owner_id uuid,
  p_cents integer,
  p_note text default null
)
returns public.business_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.business_settings;
begin
  if not public.is_service_request() then
    raise exception 'AI spend is recorded by the worker only';
  end if;

  if p_cents is null or p_cents <= 0 then
    raise exception 'a positive cost is required';
  end if;

  update public.business_settings
  set ai_spend_cents = ai_spend_cents + p_cents
  where owner_id = p_owner_id
    and ai_budget_cents > 0
    and ai_spend_cents + p_cents <= ai_budget_cents
  returning * into v_row;

  if v_row.owner_id is null then
    raise exception 'the AI spending cap would be exceeded, so nothing was recorded';
  end if;

  insert into public.agent_events (owner_id, kind, level, message, data)
  values (
    p_owner_id,
    'nova.ai_spend',
    'info',
    'AI usage recorded against the owner budget.',
    jsonb_build_object('cents', p_cents, 'note', left(coalesce(p_note, ''), 200))
  );

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function public.nova_loop_snapshot(uuid) from public, anon;
grant execute on function public.nova_loop_snapshot(uuid) to authenticated, service_role;

revoke all on function public.record_company_cycle(uuid, text, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.record_company_cycle(uuid, text, text, text, jsonb, uuid)
  to service_role;

revoke all on function public.record_ai_spend(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_ai_spend(uuid, integer, text)
  to service_role;
