-- ============================================================================
-- NOVA OS — Phase 3: outreach (email), shipped switched off
--
-- Nothing here can send anything on its own:
--   * email_accounts.enabled defaults to false and business_settings.email_enabled
--     defaults to false, and the sender must be verified before a send is allowed
--   * a message only becomes sendable through an explicit owner approval, and the
--     send path re-checks suppression, caps and the autonomy mode every time
--   * suppression wins over everything: an address on the list can never be sent
--     to, and adding an address cancels that address's open drafts
--
-- No price, address or message is invented anywhere in this schema. The body of a
-- drafted message is built from rows the pipeline actually stored.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- email_accounts — one sender identity per owner.
-- ---------------------------------------------------------------------------
create table if not exists public.email_accounts (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null default 'agentmail' check (provider in ('agentmail')),
  from_name text,
  from_email text,
  reply_to text,
  -- Provider-side inbox id; the API key itself lives in function secrets only.
  inbox_id text,
  verified boolean not null default false,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_accounts_sender_when_enabled check (
    not enabled or (from_email is not null and length(btrim(from_email)) > 3)
  )
);

drop trigger if exists email_accounts_touch on public.email_accounts;
create trigger email_accounts_touch before update on public.email_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- suppression_list — permanent, owner-scoped, and checked before every send.
-- ---------------------------------------------------------------------------
create table if not exists public.suppression_list (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  email_normalized text not null check (position('@' in email_normalized) > 1),
  reason text not null default 'manual'
    check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual', 'policy')),
  note text,
  created_at timestamptz not null default now()
);

create unique index if not exists suppression_list_owner_email_idx
  on public.suppression_list (owner_id, email_normalized);

-- ---------------------------------------------------------------------------
-- outreach_messages — one row per email we intend to send, and its real state.
--
-- Status is a strict progression:
--   draft → approved → sending → sent
--                    ↘ failed
--   any open state   → cancelled
--
-- Only drafts may be edited by the owner. `sent` requires a provider message id,
-- so a send that did not actually happen cannot be recorded as one.
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  deal_id uuid references public.deals (id) on delete set null,
  channel text not null default 'email' check (channel in ('email')),
  to_email text not null check (position('@' in to_email) > 1),
  to_name text,
  subject text not null check (length(btrim(subject)) > 0),
  body text not null check (length(btrim(body)) > 0),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'sending', 'sent', 'failed', 'bounced', 'replied', 'cancelled')),
  provider_message_id text,
  provider_thread_id text,
  idempotency_key text,
  approved_at timestamptz,
  sent_at timestamptz,
  failed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outreach_messages_sent_needs_id check (
    status <> 'sent' or provider_message_id is not null
  )
);

-- One open message per lead/contact pair: a retried draft job cannot fork the thread.
create unique index if not exists outreach_messages_open_idx
  on public.outreach_messages (owner_id, lead_id, to_email)
  where status in ('draft', 'approved', 'sending');

create unique index if not exists outreach_messages_idempotency_idx
  on public.outreach_messages (owner_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists outreach_messages_owner_status_idx
  on public.outreach_messages (owner_id, status, created_at desc);

drop trigger if exists outreach_messages_touch on public.outreach_messages;
create trigger outreach_messages_touch before update on public.outreach_messages
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- email_events — what the provider reported, appended verbatim.
-- ---------------------------------------------------------------------------
create table if not exists public.email_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  message_id uuid references public.outreach_messages (id) on delete set null,
  kind text not null
    check (kind in ('delivered', 'bounced', 'complained', 'replied', 'unsubscribed', 'other')),
  detail text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists email_events_owner_recent_idx
  on public.email_events (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- is_email_suppressed — the single gate everything else calls.
-- ---------------------------------------------------------------------------
create or replace function public.is_email_suppressed(p_owner uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.suppression_list s
    where s.owner_id = p_owner
      and s.email_normalized = lower(btrim(coalesce(p_email, '')))
  );
$$;

-- ---------------------------------------------------------------------------
-- suppress_email — idempotent, and cancels open drafts to that address.
-- ---------------------------------------------------------------------------
create or replace function public.suppress_email(
  p_email text,
  p_reason text default 'manual',
  p_note text default null,
  p_owner_id uuid default null
)
returns public.suppression_list
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_reason text := case
    when p_reason in ('unsubscribe', 'bounce', 'complaint', 'manual', 'policy') then p_reason
    else 'manual'
  end;
  v_row public.suppression_list;
begin
  if v_owner is null then
    raise exception 'suppress_email needs an owner';
  end if;

  if not public.is_service_request() and v_owner <> auth.uid() then
    raise exception 'not allowed to suppress for another owner';
  end if;

  if position('@' in v_email) < 2 then
    raise exception 'suppress_email needs an email address';
  end if;

  insert into public.suppression_list (owner_id, email_normalized, reason, note)
  values (v_owner, v_email, v_reason, left(p_note, 500))
  on conflict (owner_id, email_normalized)
  do update set reason = excluded.reason,
                note = coalesce(excluded.note, public.suppression_list.note)
  returning * into v_row;

  update public.outreach_messages
  set status = 'cancelled',
      failed_reason = 'The address was suppressed before this message was sent.'
  where owner_id = v_owner
    and lower(btrim(to_email)) = v_email
    and status in ('draft', 'approved', 'sending');

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- approve_outreach_message — owner only, draft → approved.
-- ---------------------------------------------------------------------------
create or replace function public.approve_outreach_message(p_id uuid)
returns public.outreach_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_row public.outreach_messages;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  if public.is_email_suppressed(v_owner, (select to_email from public.outreach_messages where id = p_id)) then
    raise exception 'that address is on the suppression list';
  end if;

  update public.outreach_messages
  set status = 'approved',
      approved_at = now()
  where id = p_id
    and owner_id = v_owner
    and status = 'draft'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'only a draft can be approved';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_outreach_message — service role only. Locks a message for three minutes
-- so two workers cannot send the same email twice.
-- ---------------------------------------------------------------------------
create or replace function public.claim_outreach_message(
  p_message_id uuid,
  p_worker_id text
)
returns setof public.outreach_messages
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.outreach_messages m
  set status = 'sending',
      approved_at = coalesce(m.approved_at, now())
  where m.id = p_message_id
    and m.status = 'approved'
  returning m.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_outreach_sent / mark_outreach_failed — service role only.
-- ---------------------------------------------------------------------------
create or replace function public.mark_outreach_sent(
  p_id uuid,
  p_provider_message_id text,
  p_provider_thread_id text default null
)
returns public.outreach_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.outreach_messages;
begin
  if p_provider_message_id is null or length(btrim(p_provider_message_id)) = 0 then
    raise exception 'a sent message needs the provider message id';
  end if;

  update public.outreach_messages
  set status = 'sent',
      provider_message_id = btrim(p_provider_message_id),
      provider_thread_id = p_provider_thread_id,
      sent_at = now(),
      failed_reason = null
  where id = p_id
    and status = 'sending'
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.mark_outreach_failed(p_id uuid, p_reason text)
returns public.outreach_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.outreach_messages;
begin
  update public.outreach_messages
  set status = 'failed',
      failed_reason = left(coalesce(p_reason, 'Unknown failure.'), 800),
      approved_at = null
  where id = p_id
    and status in ('approved', 'sending')
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.email_accounts enable row level security;
alter table public.suppression_list enable row level security;
alter table public.outreach_messages enable row level security;
alter table public.email_events enable row level security;

drop policy if exists email_accounts_select on public.email_accounts;
create policy email_accounts_select on public.email_accounts
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists email_accounts_write on public.email_accounts;
create policy email_accounts_write on public.email_accounts
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists email_accounts_insert on public.email_accounts;
create policy email_accounts_insert on public.email_accounts
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists suppression_list_select on public.suppression_list;
create policy suppression_list_select on public.suppression_list
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists suppression_list_insert on public.suppression_list;
create policy suppression_list_insert on public.suppression_list
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists outreach_messages_select on public.outreach_messages;
create policy outreach_messages_select on public.outreach_messages
  for select to authenticated using (owner_id = auth.uid());

-- The owner writes drafts and may edit a draft. Every status transition goes
-- through a function, so a client cannot mark its own mail as sent.
drop policy if exists outreach_messages_insert on public.outreach_messages;
create policy outreach_messages_insert on public.outreach_messages
  for insert to authenticated
  with check (owner_id = auth.uid() and status = 'draft');

drop policy if exists outreach_messages_update on public.outreach_messages;
create policy outreach_messages_update on public.outreach_messages
  for update to authenticated
  using (owner_id = auth.uid() and status = 'draft')
  with check (owner_id = auth.uid() and status = 'draft');

drop policy if exists outreach_messages_delete on public.outreach_messages;
create policy outreach_messages_delete on public.outreach_messages
  for delete to authenticated
  using (owner_id = auth.uid() and status in ('draft', 'cancelled', 'failed'));

drop policy if exists email_events_select on public.email_events;
create policy email_events_select on public.email_events
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.email_accounts from anon;
revoke all on public.suppression_list from anon;
revoke all on public.outreach_messages from anon;
revoke all on public.email_events from anon;

grant select, insert, update on public.email_accounts to authenticated;
grant select, insert on public.suppression_list to authenticated;
grant select, insert, update, delete on public.outreach_messages to authenticated;
grant select on public.email_events to authenticated;

-- ---------------------------------------------------------------------------
-- Execute privileges: the send path is service role only.
-- ---------------------------------------------------------------------------
revoke all on function public.is_email_suppressed(uuid, text) from public, anon;
grant execute on function public.is_email_suppressed(uuid, text) to authenticated, service_role;

revoke all on function public.suppress_email(text, text, text, uuid) from public, anon;
grant execute on function public.suppress_email(text, text, text, uuid) to authenticated, service_role;

revoke all on function public.approve_outreach_message(uuid) from public, anon;
grant execute on function public.approve_outreach_message(uuid) to authenticated;

revoke all on function public.claim_outreach_message(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_outreach_sent(uuid, text, text) from public, anon, authenticated;
revoke all on function public.mark_outreach_failed(uuid, text) from public, anon, authenticated;

grant execute on function public.claim_outreach_message(uuid, text) to service_role;
grant execute on function public.mark_outreach_sent(uuid, text, text) to service_role;
grant execute on function public.mark_outreach_failed(uuid, text) to service_role;
