-- ============================================================================
-- NOVA OS — Phase 5: inbox replies and the deal pipeline
--
-- Reply handling is deliberately small and evidence-only:
--   * the provider's event is inserted verbatim into email_events, with a
--     deterministic `intent` label derived from the message text
--   * an unsubscribe-style request suppresses the address immediately, which
--     also cancels any open draft to it
--   * a deal moves only on a real reply: replied, lost, or do_not_contact
--
-- No model is called and no reply text is ever composed. The intent is a hint
-- for the owner, not a claim about what the customer meant.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- email_events.intent — a small, fixed vocabulary so nothing is free text.
-- ---------------------------------------------------------------------------
alter table public.email_events
  add column if not exists intent text
  check (intent in ('interested', 'question', 'not_interested', 'unsubscribe', 'other'));

-- ---------------------------------------------------------------------------
-- record_email_event — the single write path for provider events.
--
-- Service role only. Ownership comes from our own message row, never from the
-- request body.
-- ---------------------------------------------------------------------------
create or replace function public.record_email_event(
  p_message_id uuid,
  p_kind text,
  p_detail text default null,
  p_text text default null,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message public.outreach_messages;
  v_kind text;
  v_text text := lower(coalesce(p_text, ''));
  v_intent text := 'other';
  v_deal public.deals;
  v_stage text;
  v_next text;
begin
  if not public.is_service_request() then
    raise exception 'provider events are recorded by the worker only';
  end if;

  v_kind := case
    when p_kind in ('delivered', 'bounced', 'complained', 'replied', 'unsubscribed', 'other')
      then p_kind
    else 'other'
  end;

  select * into v_message from public.outreach_messages where id = p_message_id;
  if v_message.id is null then
    raise exception 'unknown message';
  end if;

  -- Deterministic labels. Order matters: an opt-out always wins.
  if v_kind = 'unsubscribed' then
    v_intent := 'unsubscribe';
  elsif v_kind = 'replied' then
    if v_text ~ '(unsubscribe|opt[ -]?out|stop emailing|remove me|do not (contact|email)|don''t contact)'
      or v_text ~ '(take me off)' then
      v_intent := 'unsubscribe';
    elsif v_text ~ '(not interested|no thanks|no thank you|not for us|not right now)'
      or v_text ~ '(we already have|already (have|use) (a|an))' then
      v_intent := 'not_interested';
    elsif v_text ~ '\?'
      or v_text ~ '(how much|price|pricing|cost|quote|more (info|information|details)|details|call me|send (me )?more)'
      or v_text ~ '(interested|tell me more|sounds good|let us talk)' then
      v_intent := 'question';
    end if;
  end if;

  insert into public.email_events (owner_id, message_id, kind, intent, detail, payload)
  values (
    v_message.owner_id,
    v_message.id,
    v_kind,
    v_intent,
    left(coalesce(p_detail, ''), 500),
    coalesce(p_payload, '{}'::jsonb)
  );

  -- Suppression wins over everything and cancels this address's open drafts.
  if v_intent = 'unsubscribe' then
    perform public.suppress_email(
      v_message.to_email,
      'unsubscribe',
      'The recipient asked not to be contacted again.',
      v_message.owner_id
    );
  elsif v_kind = 'bounced' then
    perform public.suppress_email(
      v_message.to_email, 'bounce', 'Recorded from a provider bounce.', v_message.owner_id
    );
  elsif v_kind = 'complained' then
    perform public.suppress_email(
      v_message.to_email, 'complaint', 'Recorded from a provider complaint.', v_message.owner_id
    );
  end if;

  if v_kind = 'replied' then
    update public.outreach_messages
    set status = 'replied'
    where id = v_message.id
      and status = 'sent';

    if v_message.lead_id is not null then
      v_stage := case
        when v_intent = 'unsubscribe' then 'do_not_contact'
        when v_intent = 'not_interested' then 'lost'
        else 'replied'
      end;

      v_next := case
        when v_intent = 'unsubscribe' then 'Suppressed. Do not contact this address again.'
        when v_intent = 'not_interested' then 'Closed: they said no. Nothing is sent automatically.'
        when v_intent = 'question' then 'They asked something. Read the reply and answer it yourself.'
        else 'Read the reply and answer it yourself.'
      end;

      update public.deals
      set stage = v_stage,
          next_action = v_next
      where owner_id = v_message.owner_id
        and lead_id = v_message.lead_id
        and stage not in ('won', 'lost', 'do_not_contact')
      returning * into v_deal;
    end if;
  end if;

  return jsonb_build_object(
    'message_id', v_message.id,
    'kind', v_kind,
    'intent', v_intent,
    'suppressed', v_intent = 'unsubscribe' or v_kind in ('bounced', 'complained'),
    'deal_stage', v_deal.stage
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_quote — unchanged rules, plus the deal advance that follows acceptance.
-- ---------------------------------------------------------------------------
create or replace function public.accept_quote(
  p_quote_id uuid,
  p_via text default 'link',
  p_accepted_by text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.quotes;
begin
  if not public.is_service_request() then
    raise exception 'quote acceptance is recorded by the worker only';
  end if;

  update public.quotes
  set status = 'accepted',
      accepted_at = now(),
      accepted_via = case when p_via in ('link', 'email', 'manual') then p_via else 'link' end,
      accepted_by = left(coalesce(p_accepted_by, accepted_by), 200)
  where id = p_quote_id
    and status = 'sent'
    and (expires_at is null or expires_at > now())
  returning * into v_row;

  if v_row.id is null then
    raise exception 'only a sent, unexpired quote can be accepted';
  end if;

  if v_row.lead_id is not null then
    update public.deals
    set stage = 'ready_to_purchase',
        next_action = 'They accepted the quote. Connect a payment provider before collecting anything.'
    where owner_id = v_row.owner_id
      and lead_id = v_row.lead_id
      and stage not in ('won', 'do_not_contact');
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges: the event write path is service role only.
-- ---------------------------------------------------------------------------
revoke all on function public.record_email_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_email_event(uuid, text, text, text, jsonb) to service_role;

revoke all on function public.accept_quote(uuid, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote(uuid, text, text) to service_role;
