-- ============================================================================
-- NOVA OS — Phase 7: delivery and retention
--
-- A delivery is a customer-specific link to the stored files, not a screenshot
-- and not a public bucket. The link token exists only in the customer's email;
-- the database stores its SHA-256 hash, an expiry and a revocation time.
--
-- When a customer asks for a revision, the paid order's production job is
-- re-armed: attempts reset, a new version is generated, SENTINEL checks it, and
-- the owner can deliver again. The revision allowance is still enforced by
-- `request_deliverable_revision`.
-- ============================================================================

alter table public.deliverables
  add column if not exists delivery_message_id uuid
    references public.outreach_messages (id) on delete set null;

create table if not exists public.delivery_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  deliverable_id uuid not null references public.deliverables (id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  access_count integer not null default 0 check (access_count >= 0),
  last_accessed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists delivery_links_deliverable_idx
  on public.delivery_links (deliverable_id, created_at desc);

-- A delivery email is its own thread. It must not be blocked by an unfinished
-- marketing draft to the same customer, and its per-deliverable idempotency key
-- still prevents a second delivery message.
drop index if exists public.outreach_messages_open_idx;
create unique index outreach_messages_open_idx
  on public.outreach_messages (owner_id, lead_id, to_email)
  where status in ('draft', 'approved', 'sending')
    and (idempotency_key is null or idempotency_key not like 'delivery:%');

-- ---------------------------------------------------------------------------
-- create_delivery_link — service role only; the token itself is never stored.
-- ---------------------------------------------------------------------------
create or replace function public.create_delivery_link(
  p_deliverable_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns public.delivery_links
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deliverable public.deliverables;
  v_row public.delivery_links;
begin
  if not public.is_service_request() then
    raise exception 'delivery links are created by the worker only';
  end if;

  if p_token_hash is null or length(p_token_hash) <> 64 then
    raise exception 'a 64-character token hash is required';
  end if;

  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    raise exception 'the link expiry must be within the next 90 days';
  end if;

  select * into v_deliverable from public.deliverables where id = p_deliverable_id;
  if v_deliverable.id is null then
    raise exception 'unknown deliverable';
  end if;
  if v_deliverable.status = 'cancelled' then
    raise exception 'a cancelled delivery cannot be linked';
  end if;

  insert into public.delivery_links (owner_id, deliverable_id, token_hash, expires_at)
  values (v_deliverable.owner_id, v_deliverable.id, p_token_hash, p_expires_at)
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- resolve_delivery_token — the public page's one query.
--
-- Returns no row for an unknown, expired or revoked token, so the caller cannot
-- distinguish "wrong" from "expired" by the response shape.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_delivery_token(p_token_hash text)
returns table (
  link_id uuid,
  deliverable_id uuid,
  owner_id uuid,
  expires_at timestamptz,
  status text,
  title text,
  scope text,
  quote_id uuid,
  lead_id uuid,
  revisions_included integer,
  revisions_used integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.delivery_links;
  v_deliverable public.deliverables;
begin
  if not public.is_service_request() then
    raise exception 'delivery tokens are resolved by the public function only';
  end if;

  select * into v_link from public.delivery_links where token_hash = p_token_hash;
  if v_link.id is null then return; end if;
  if v_link.revoked_at is not null or v_link.expires_at <= now() then return; end if;

  select * into v_deliverable from public.deliverables where id = v_link.deliverable_id;
  if v_deliverable.id is null then return; end if;

  update public.delivery_links
  set access_count = access_count + 1,
      last_accessed_at = now()
  where id = v_link.id;

  return query
  select v_link.id, v_deliverable.id, v_deliverable.owner_id, v_link.expires_at,
         v_deliverable.status, v_deliverable.title, v_deliverable.scope,
         v_deliverable.quote_id, v_deliverable.lead_id,
         v_deliverable.revisions_included, v_deliverable.revisions_used;
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_delivery_link — the owner can kill a link immediately.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_delivery_link(p_id uuid)
returns public.delivery_links
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_row public.delivery_links;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  update public.delivery_links
  set revoked_at = now()
  where id = p_id and owner_id = v_owner and revoked_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no active delivery link to revoke';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- A revision re-arms the production job.
-- ---------------------------------------------------------------------------
create or replace function public.rearm_production_for_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.production_jobs;
begin
  if new.status = 'revision_requested' and new.status is distinct from old.status then
    select * into v_job
    from public.production_jobs
    where quote_id = new.quote_id
    order by created_at desc
    limit 1;

    if v_job.id is not null then
      update public.production_jobs
      set status = 'queued',
          attempts = 0,
          deliverable_id = new.id,
          qa_notes = left('Customer revision: ' || coalesce(new.revision_note, ''), 1200),
          finished_at = null
      where id = v_job.id;

      perform public.enqueue_agent_job(
        'forge.produce',
        jsonb_build_object('jobId', v_job.id, 'revision', new.revisions_used),
        'forge:' || v_job.id::text || ':v' || v_job.version::text ||
          ':r' || new.revisions_used::text,
        now(),
        50,
        new.owner_id
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists deliverables_rearm_production on public.deliverables;
create trigger deliverables_rearm_production
  after update of status on public.deliverables
  for each row execute function public.rearm_production_for_revision();

-- ---------------------------------------------------------------------------
-- customer_history — one row per customer with a real paid order.
-- ---------------------------------------------------------------------------
create or replace function public.customer_history(p_limit integer default 50)
returns table (
  lead_id uuid,
  business_name text,
  orders_count integer,
  paid_cents bigint,
  deliverables_count integer,
  accepted_count integer,
  last_delivered_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.business_name,
    (select count(*)::integer from public.orders o
      where o.owner_id = l.owner_id and o.lead_id = l.id),
    (select coalesce(sum(o.amount_cents), 0)::bigint from public.orders o
      where o.owner_id = l.owner_id and o.lead_id = l.id
        and o.status in ('paid', 'fulfilled')),
    (select count(*)::integer from public.deliverables d
      where d.owner_id = l.owner_id and d.lead_id = l.id),
    (select count(*)::integer from public.deliverables d
      where d.owner_id = l.owner_id and d.lead_id = l.id and d.status = 'accepted'),
    (select max(d.delivered_at) from public.deliverables d
      where d.owner_id = l.owner_id and d.lead_id = l.id)
  from public.leads l
  where l.owner_id = auth.uid()
    and exists (
      select 1 from public.orders o
      where o.owner_id = l.owner_id and o.lead_id = l.id
    )
  order by 7 desc nulls last, l.business_name asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.delivery_links enable row level security;

drop policy if exists delivery_links_select on public.delivery_links;
create policy delivery_links_select on public.delivery_links
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.delivery_links from anon, authenticated;
grant select on public.delivery_links to authenticated;
grant all on public.delivery_links to service_role;

-- The delivery worker records the link and the delivered state; the app stays
-- read-only on this table.
grant select, update on public.deliverables to service_role;
grant select, insert, update, delete on public.outreach_messages to service_role;

revoke all on function public.create_delivery_link(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_delivery_link(uuid, text, timestamptz)
  to service_role;

revoke all on function public.resolve_delivery_token(text)
  from public, anon, authenticated;
grant execute on function public.resolve_delivery_token(text)
  to service_role;

revoke all on function public.revoke_delivery_link(uuid) from public, anon;
grant execute on function public.revoke_delivery_link(uuid) to authenticated;

revoke all on function public.customer_history(integer) from public, anon;
grant execute on function public.customer_history(integer) to authenticated;
