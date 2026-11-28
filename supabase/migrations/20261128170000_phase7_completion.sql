-- ============================================================================
-- NOVA OS — Phase 7 completion: receipt, review, recurring service, customer
-- revision requests and link revocation.
--
-- Phase 7 shipped delivery links, the delivery email, revision re-production and
-- customer history. The roadmap also asks for:
--
--   * follow-ups for receipt, satisfaction/review and relevant recurring
--     services, respecting preferences and opt-outs
--   * revision handling from the customer's own delivery link
--   * a way to revoke a link after the app has been reopened
--
-- The follow-up rules stay the same as Phase 3: a reply, bounce or suppression
-- cancels every open follow-up, a due follow-up becomes a draft that needs the
-- owner's approval, and nothing is sent automatically.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- More follow-up kinds. One open follow-up per message *per kind*, so a
-- delivery can carry a receipt check, a review ask and a later service check-in
-- without the three colliding on the Phase 3 one-per-message index.
-- ---------------------------------------------------------------------------
alter table public.follow_ups drop constraint if exists follow_ups_kind_check;
alter table public.follow_ups add constraint follow_ups_kind_check
  check (kind in ('follow_up', 'retention', 'receipt', 'review', 'recurring'));

drop index if exists public.follow_ups_open_idx;
create unique index follow_ups_open_idx
  on public.follow_ups (owner_id, message_id, kind)
  where status = 'scheduled';

-- Replace the scheduler so the new kinds survive the mapping. The default
-- 'follow_up' kind still refuses a second open row for the same message, which
-- is what the Phase 3 assertions expect.
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
  v_kind text := case
    when p_kind in ('follow_up', 'retention', 'receipt', 'review', 'recurring') then p_kind
    else 'follow_up'
  end;
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
    v_kind,
    p_due_at,
    left(coalesce(p_note, ''), 500)
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- schedule_delivery_follow_ups — the retention plan for one real delivery.
--
-- Owner-callable from the app, service-callable from the worker. It refuses a
-- message that was never sent, a message that did not deliver any work, and an
-- address or lead that has opted out. Repeating the call is idempotent: only the
-- kinds that are not already scheduled are added.
-- ---------------------------------------------------------------------------
create or replace function public.schedule_delivery_follow_ups(
  p_message_id uuid,
  p_receipt_days integer default 2,
  p_review_days integer default 7,
  p_recurring_days integer default 60,
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
  v_message public.outreach_messages;
  v_deliverable public.deliverables;
  v_suppressed boolean := false;
  v_opted_out boolean := false;
  v_lead_status text;
  v_kind text;
  v_due timestamptz;
  v_note text;
  v_scheduled text[] := '{}';
  v_receipt integer := greatest(1, least(coalesce(p_receipt_days, 2), 14));
  v_review integer := greatest(2, least(coalesce(p_review_days, 7), 60));
  v_recurring integer := greatest(30, least(coalesce(p_recurring_days, 60), 365));
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  if not public.is_service_request() and v_owner <> auth.uid() then
    raise exception 'not allowed to schedule follow-ups for another owner';
  end if;

  select * into v_message
  from public.outreach_messages
  where id = p_message_id and owner_id = v_owner;

  if v_message.id is null then
    raise exception 'unknown message';
  end if;

  if v_message.status <> 'sent' then
    raise exception 'retention follow-ups need a delivery email that was actually sent';
  end if;

  select * into v_deliverable
  from public.deliverables
  where owner_id = v_owner and delivery_message_id = v_message.id
  order by delivered_at desc nulls last
  limit 1;

  if v_deliverable.id is null then
    raise exception 'that message did not deliver any work';
  end if;

  select public.is_email_suppressed(v_owner, v_message.to_email) into v_suppressed;

  select coalesce(bool_or(c.opted_out), false)
  into v_opted_out
  from public.contacts c
  where c.owner_id = v_owner
    and (
      c.id = v_message.contact_id
      or c.email_normalized = lower(btrim(v_message.to_email))
    );

  select status into v_lead_status
  from public.leads
  where id = v_message.lead_id and owner_id = v_owner;

  -- Do-not-contact is a deal stage, not a lead status. Check the deal as well.
  if v_suppressed
     or v_opted_out
     or v_lead_status = 'do_not_contact'
     or exists (
       select 1 from public.deals d
       where d.owner_id = v_owner
         and d.lead_id = v_message.lead_id
         and d.stage = 'do_not_contact'
     ) then
    -- Record the decision once, so the autonomous loop does not keep offering
    -- the same plan to a customer who opted out. A skipped row is not open, so
    -- the owner can still schedule a plan later if the preference changes.
    foreach v_kind in array array['receipt', 'review', 'recurring'] loop
      if not exists (
        select 1 from public.follow_ups
        where owner_id = v_owner
          and message_id = v_message.id
          and kind = v_kind
      ) then
        insert into public.follow_ups (
          owner_id, message_id, lead_id, contact_id, kind, status, due_at, note
        )
        values (
          v_owner,
          v_message.id,
          v_message.lead_id,
          v_message.contact_id,
          v_kind,
          'skipped',
          now() + interval '1 day',
          'Skipped: the customer opted out or is marked do not contact.'
        );
      end if;
    end loop;

    return jsonb_build_object(
      'scheduled', '[]'::jsonb,
      'skipped', 'opt_out',
      'messageId', v_message.id,
      'deliverableId', v_deliverable.id
    );
  end if;

  foreach v_kind in array array['receipt', 'review', 'recurring'] loop
    if exists (
      select 1 from public.follow_ups
      where owner_id = v_owner
        and message_id = v_message.id
        and kind = v_kind
        and status = 'scheduled'
    ) then
      continue;
    end if;

    v_due := now() + make_interval(days => case v_kind
      when 'receipt' then v_receipt
      when 'review' then v_review
      else v_recurring
    end);

    v_note := case v_kind
      when 'receipt' then
        'Check the files opened and the customer received what they paid for.'
      when 'review' then
        'Ask how the work is going and whether they would leave a short review. Do not offer an incentive.'
      else
        'Ask whether they would like "' || left(v_deliverable.title, 120) ||
          '" refreshed. Do not assume a schedule, a scope or a price.'
    end;

    insert into public.follow_ups (
      owner_id, message_id, lead_id, contact_id, kind, due_at, note
    )
    values (
      v_owner,
      v_message.id,
      v_message.lead_id,
      v_message.contact_id,
      v_kind,
      v_due,
      v_note
    );

    v_scheduled := array_append(v_scheduled, v_kind);
  end loop;

  return jsonb_build_object(
    'scheduled', to_jsonb(v_scheduled),
    'skipped', null,
    'messageId', v_message.id,
    'deliverableId', v_deliverable.id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- request_delivery_revision — the customer asks for a change from their link.
--
-- The link token is the authorization: there is no session. The function still
-- refuses an unknown, expired or revoked link, a delivery that is not waiting
-- for feedback, an accepted delivery and an exhausted revision allowance. The
-- status change fires the Phase 7 trigger that re-arms FORGE and SENTINEL.
-- ---------------------------------------------------------------------------
create or replace function public.request_delivery_revision(
  p_token_hash text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.delivery_links;
  v_deliverable public.deliverables;
  v_note text := btrim(coalesce(p_note, ''));
  v_remaining integer;
begin
  if not public.is_service_request() then
    raise exception 'revisions from a delivery link are recorded by the public function only';
  end if;

  if p_token_hash is null or length(p_token_hash) <> 64 then
    raise exception 'this delivery link is no longer available';
  end if;

  if length(v_note) < 3 then
    raise exception 'say what you would like changed';
  end if;

  select * into v_link
  from public.delivery_links
  where token_hash = p_token_hash;

  if v_link.id is null
     or v_link.revoked_at is not null
     or v_link.expires_at <= now() then
    raise exception 'this delivery link is no longer available';
  end if;

  select * into v_deliverable
  from public.deliverables
  where id = v_link.deliverable_id;

  if v_deliverable.id is null then
    raise exception 'this delivery link is no longer available';
  end if;

  if v_deliverable.status = 'accepted' then
    raise exception 'this delivery was already accepted';
  end if;

  if v_deliverable.status <> 'delivered' then
    raise exception 'this delivery is not waiting for a revision';
  end if;

  if v_deliverable.revisions_used >= v_deliverable.revisions_included then
    raise exception 'no revisions are left on this order';
  end if;

  update public.deliverables
  set status = 'revision_requested',
      revisions_used = revisions_used + 1,
      revision_note = left(v_note, 1000)
  where id = v_deliverable.id;

  v_remaining := greatest(0, v_deliverable.revisions_included - v_deliverable.revisions_used - 1);

  insert into public.agent_events (owner_id, kind, level, message, data)
  values (
    v_deliverable.owner_id,
    'closer.revision_requested',
    'info',
    'The customer requested a revision from their delivery link.',
    jsonb_build_object(
      'deliverableId', v_deliverable.id,
      'linkId', v_link.id,
      'revisionsRemaining', v_remaining
    )
  );

  return jsonb_build_object(
    'ok', true,
    'deliverableId', v_deliverable.id,
    'revisionsRemaining', v_remaining
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_delivery_links — revoke every live link for one delivery.
--
-- The Phase 7 `revoke_delivery_link(id)` needs the app to have kept the link id.
-- After a restart it may only know the deliverable, so this is the app's way to
-- withdraw a link it can no longer identify.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_delivery_links(p_deliverable_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_count integer := 0;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  if not exists (
    select 1 from public.deliverables
    where id = p_deliverable_id and owner_id = v_owner
  ) then
    raise exception 'unknown delivery';
  end if;

  update public.delivery_links
  set revoked_at = now()
  where deliverable_id = p_deliverable_id
    and owner_id = v_owner
    and revoked_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.schedule_follow_up(uuid, timestamptz, text, text)
  from public, anon;
grant execute on function public.schedule_follow_up(uuid, timestamptz, text, text)
  to authenticated;

revoke all on function public.schedule_delivery_follow_ups(uuid, integer, integer, integer, uuid)
  from public, anon;
grant execute on function public.schedule_delivery_follow_ups(uuid, integer, integer, integer, uuid)
  to authenticated, service_role;

revoke all on function public.request_delivery_revision(text, text)
  from public, anon, authenticated;
grant execute on function public.request_delivery_revision(text, text)
  to service_role;

revoke all on function public.revoke_delivery_links(uuid) from public, anon;
grant execute on function public.revoke_delivery_links(uuid) to authenticated;
