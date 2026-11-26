-- ============================================================================
-- NOVA OS — Phase 6: production and delivery
--
-- The roadmap rule this file enforces: work exists only for an accepted quote,
-- and a delivery counts only when there is an artifact to point at. Nothing here
-- invents a deliverable, a delivery date or a revision.
--
--   accepted quote → delivery opened → work started → delivered (artifact URL)
--                  → accepted, or one bounded revision at a time
--
-- When payments are live for the owner, delivery cannot start until a succeeded
-- payment record exists for that quote. With payments off (the default) the
-- delivery is tracked without claiming anyone paid.
-- ============================================================================

create table if not exists public.deliverables (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  quote_id uuid not null unique references public.quotes (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  title text not null check (length(btrim(title)) > 0),
  scope text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'delivered', 'accepted', 'revision_requested', 'cancelled')),
  due_at timestamptz,
  started_at timestamptz,
  delivered_at timestamptz,
  accepted_at timestamptz,
  revisions_included integer not null default 1 check (revisions_included between 0 and 10),
  revisions_used integer not null default 0 check (revisions_used >= 0),
  artifact_url text,
  revision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A delivery is a link to real work, not a status someone typed.
  constraint deliverables_delivered_needs_artifact check (
    status not in ('delivered', 'accepted')
    or (artifact_url is not null and length(btrim(artifact_url)) > 8)
  ),
  constraint deliverables_accepted_needs_delivery check (
    status <> 'accepted' or delivered_at is not null
  ),
  constraint deliverables_revisions_within_allowance check (
    revisions_used <= revisions_included
  )
);

create index if not exists deliverables_owner_status_idx
  on public.deliverables (owner_id, status, due_at);

drop trigger if exists deliverables_touch on public.deliverables;
create trigger deliverables_touch before update on public.deliverables
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- open_delivery — an accepted quote becomes tracked work, once.
-- ---------------------------------------------------------------------------
create or replace function public.open_delivery(p_quote_id uuid)
returns public.deliverables
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_quote public.quotes;
  v_live boolean;
  v_revisions integer;
  v_row public.deliverables;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and owner_id = v_owner;

  if v_quote.id is null then
    raise exception 'unknown quote';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'only an accepted quote can be delivered';
  end if;

  if exists (select 1 from public.deliverables where quote_id = v_quote.id) then
    raise exception 'a delivery is already open for this quote';
  end if;

  select payments_live into v_live
  from public.business_settings
  where owner_id = v_owner;

  if coalesce(v_live, false) and not exists (
    select 1
    from public.payment_intents
    where quote_id = v_quote.id and status = 'succeeded'
  ) then
    raise exception 'payments are live: record the payment before starting delivery';
  end if;

  if v_quote.service_key is not null then
    select revisions into v_revisions
    from public.service_catalog
    where owner_id = v_owner and key = v_quote.service_key;
  end if;

  insert into public.deliverables (
    owner_id, quote_id, deal_id, lead_id, title, scope, due_at, revisions_included
  )
  values (
    v_owner,
    v_quote.id,
    v_quote.deal_id,
    v_quote.lead_id,
    v_quote.title,
    v_quote.scope,
    coalesce(v_quote.accepted_at, now()) + make_interval(days => v_quote.delivery_days),
    greatest(0, least(10, coalesce(v_revisions, 1)))
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- start_deliverable — pending (or a revision request) → in progress.
-- ---------------------------------------------------------------------------
create or replace function public.start_deliverable(p_id uuid)
returns public.deliverables
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.deliverables;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;

  update public.deliverables
  set status = 'in_progress',
      started_at = coalesce(started_at, now())
  where id = p_id
    and owner_id = auth.uid()
    and status in ('pending', 'revision_requested')
  returning * into v_row;

  if v_row.id is null then
    raise exception 'only a pending delivery can be started';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_deliverable_delivered — requires a real artifact URL.
-- ---------------------------------------------------------------------------
create or replace function public.mark_deliverable_delivered(
  p_id uuid,
  p_artifact_url text
)
returns public.deliverables
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := btrim(coalesce(p_artifact_url, ''));
  v_row public.deliverables;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;

  if v_url !~* '^https?://' or length(v_url) < 10 then
    raise exception 'a delivery needs a real http(s) link to the work';
  end if;

  update public.deliverables
  set status = 'delivered',
      artifact_url = v_url,
      delivered_at = now(),
      revision_note = null
  where id = p_id
    and owner_id = auth.uid()
    and status in ('pending', 'in_progress', 'revision_requested')
  returning * into v_row;

  if v_row.id is null then
    raise exception 'only open work can be marked delivered';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_deliverable — the owner's own acceptance, and the only automatic
-- "won": it is evidence the work was delivered and accepted.
-- ---------------------------------------------------------------------------
create or replace function public.accept_deliverable(p_id uuid)
returns public.deliverables
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.deliverables;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;

  update public.deliverables
  set status = 'accepted',
      accepted_at = now()
  where id = p_id
    and owner_id = auth.uid()
    and status = 'delivered'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'only a delivered item can be accepted';
  end if;

  if v_row.deal_id is not null then
    update public.deals
    set stage = 'won'
    where id = v_row.deal_id
      and owner_id = auth.uid()
      and stage <> 'won';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- request_deliverable_revision — bounded by the service's revision allowance.
-- ---------------------------------------------------------------------------
create or replace function public.request_deliverable_revision(
  p_id uuid,
  p_note text
)
returns public.deliverables
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
  v_row public.deliverables;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;

  if length(v_note) < 3 then
    raise exception 'a revision request needs a note saying what to change';
  end if;

  update public.deliverables
  set status = 'revision_requested',
      revisions_used = revisions_used + 1,
      revision_note = left(v_note, 1000)
  where id = p_id
    and owner_id = auth.uid()
    and status = 'delivered'
    and revisions_used < revisions_included
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no revision is left, or the work is not delivered';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS — read only from the app; every transition is a function above.
-- ---------------------------------------------------------------------------
alter table public.deliverables enable row level security;

drop policy if exists deliverables_select on public.deliverables;
create policy deliverables_select on public.deliverables
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.deliverables from anon;
grant select on public.deliverables to authenticated;

-- ---------------------------------------------------------------------------
-- Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function public.open_delivery(uuid) from public, anon;
grant execute on function public.open_delivery(uuid) to authenticated;

revoke all on function public.start_deliverable(uuid) from public, anon;
grant execute on function public.start_deliverable(uuid) to authenticated;

revoke all on function public.mark_deliverable_delivered(uuid, text) from public, anon;
grant execute on function public.mark_deliverable_delivered(uuid, text) to authenticated;

revoke all on function public.accept_deliverable(uuid) from public, anon;
grant execute on function public.accept_deliverable(uuid) to authenticated;

revoke all on function public.request_deliverable_revision(uuid, text) from public, anon;
grant execute on function public.request_deliverable_revision(uuid, text) to authenticated;
