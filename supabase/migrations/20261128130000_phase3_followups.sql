-- ============================================================================
-- NOVA OS — Phase 3 completion: follow-ups and reply safety
--
-- The roadmap asks for "follow-up scheduling/cancel" and "stop follow-ups after
-- replies/opt-outs". This migration adds the schedule, the owner controls, and
-- the two triggers that make cancellation automatic:
--
--   * a replied, bounced or cancelled message cancels its open follow-up
--   * a suppressed address cancels every open follow-up to it
--
-- Scheduling is a function rather than an insert policy: the database checks
-- that the original message was actually sent, that it belongs to the caller,
-- and that the address is not suppressed. No follow-up can be scheduled against
-- a message that never left the building.
-- ============================================================================

create table if not exists public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  message_id uuid not null references public.outreach_messages (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  kind text not null default 'follow_up'
    check (kind in ('follow_up', 'retention')),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'drafted', 'sent', 'cancelled', 'skipped')),
  due_at timestamptz not null,
  note text,
  draft_message_id uuid references public.outreach_messages (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One open follow-up per sent message. A retried schedule call cannot fork it.
create unique index if not exists follow_ups_open_idx
  on public.follow_ups (owner_id, message_id)
  where status = 'scheduled';

create index if not exists follow_ups_owner_due_idx
  on public.follow_ups (owner_id, status, due_at);

drop trigger if exists follow_ups_touch on public.follow_ups;
create trigger follow_ups_touch before update on public.follow_ups
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- schedule_follow_up — owner only, sent message only, never a suppressed inbox.
-- ---------------------------------------------------------------------------
create or replace function public.schedule_follow_up(
  p_message_id uuid,
  p_due_at timestamptz,
  p_note text default null,
  p_kind text default 'follow_up'
)
returns public.follow_ups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_message public.outreach_messages;
  v_row public.follow_ups;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  if p_due_at is null or p_due_at <= now() then
    raise exception 'a follow-up must be scheduled in the future';
  end if;

  select * into v_message
  from public.outreach_messages
  where id = p_message_id and owner_id = v_owner;

  if v_message.id is null then
    raise exception 'unknown message';
  end if;

  if v_message.status <> 'sent' then
    raise exception 'only a sent message can have a follow-up';
  end if;

  if public.is_email_suppressed(v_owner, v_message.to_email) then
    raise exception 'that address is on the suppression list';
  end if;

  insert into public.follow_ups (
    owner_id, message_id, lead_id, contact_id, kind, due_at, note
  )
  values (
    v_owner,
    v_message.id,
    v_message.lead_id,
    v_message.contact_id,
    case when p_kind = 'retention' then 'retention' else 'follow_up' end,
    p_due_at,
    left(coalesce(p_note, ''), 500)
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_follow_up — the owner can always stop one.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_follow_up(p_id uuid)
returns public.follow_ups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_row public.follow_ups;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  update public.follow_ups
  set status = 'cancelled'
  where id = p_id
    and owner_id = v_owner
    and status = 'scheduled'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no scheduled follow-up to cancel';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_follow_up_drafted — the worker records the draft it produced.
-- ---------------------------------------------------------------------------
create or replace function public.mark_follow_up_drafted(
  p_id uuid,
  p_draft_message_id uuid
)
returns public.follow_ups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.follow_ups;
begin
  if not public.is_service_request() then
    raise exception 'follow-up drafts are recorded by the worker only';
  end if;

  update public.follow_ups
  set status = 'drafted',
      draft_message_id = p_draft_message_id
  where id = p_id
    and status = 'scheduled'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no scheduled follow-up to mark drafted';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Automatic cancellation.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_follow_ups_for_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('replied', 'bounced', 'cancelled')
     and new.status is distinct from old.status then
    update public.follow_ups
    set status = 'cancelled'
    where message_id = new.id
      and owner_id = new.owner_id
      and status = 'scheduled';
  end if;

  return new;
end;
$$;

drop trigger if exists outreach_messages_cancel_followups on public.outreach_messages;
create trigger outreach_messages_cancel_followups
  after update of status on public.outreach_messages
  for each row execute function public.cancel_follow_ups_for_message();

create or replace function public.cancel_follow_ups_for_suppression()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.follow_ups f
  set status = 'cancelled'
  from public.outreach_messages m
  where f.message_id = m.id
    and f.owner_id = new.owner_id
    and f.status = 'scheduled'
    and m.to_email = new.email_normalized;

  return new;
end;
$$;

drop trigger if exists suppression_list_cancel_followups on public.suppression_list;
create trigger suppression_list_cancel_followups
  after insert on public.suppression_list
  for each row execute function public.cancel_follow_ups_for_suppression();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table public.follow_ups enable row level security;

drop policy if exists follow_ups_select on public.follow_ups;
create policy follow_ups_select on public.follow_ups
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.follow_ups from anon, authenticated;
grant select on public.follow_ups to authenticated;
grant all on public.follow_ups to service_role;

revoke all on function public.schedule_follow_up(uuid, timestamptz, text, text)
  from public, anon;
grant execute on function public.schedule_follow_up(uuid, timestamptz, text, text)
  to authenticated;

revoke all on function public.cancel_follow_up(uuid) from public, anon;
grant execute on function public.cancel_follow_up(uuid) to authenticated;

revoke all on function public.mark_follow_up_drafted(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_follow_up_drafted(uuid, uuid) to service_role;
