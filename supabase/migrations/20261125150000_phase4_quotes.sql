-- ============================================================================
-- NOVA OS — Phase 4: quotes and payment intents
--
-- The roadmap rule this file exists to enforce:
--   "Payment creation is permitted only after the customer expressly accepts."
--
-- So a payment intent cannot be created from a draft, a sent quote, or an
-- expired one. It needs an accepted quote, a positive amount, and payments
-- switched live by the owner. Nothing here charges anything: an intent is a
-- request to charge, and it starts in `requires_payment`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- quotes — an offer the owner has decided to make.
-- ---------------------------------------------------------------------------
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete set null,
  service_key text,
  title text not null check (length(btrim(title)) > 0),
  scope text not null default '',
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd' check (currency in ('usd')),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  delivery_days integer not null default 7 check (delivery_days between 1 and 90),
  expires_at timestamptz,
  sent_at timestamptz,
  accepted_at timestamptz,
  accepted_via text check (accepted_via in ('link', 'email', 'manual')),
  accepted_by text,
  declined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An accepted quote must say when and how it was accepted.
  constraint quotes_accepted_needs_proof check (
    status <> 'accepted' or (accepted_at is not null and accepted_via is not null)
  )
);

create index if not exists quotes_owner_status_idx
  on public.quotes (owner_id, status, created_at desc);

drop trigger if exists quotes_touch on public.quotes;
create trigger quotes_touch before update on public.quotes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- payment_intents — a request to charge, never a charge.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  provider text not null default 'none' check (provider in ('none', 'stripe')),
  provider_ref text,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd' check (currency in ('usd')),
  status text not null default 'requires_payment'
    check (status in ('requires_payment', 'pending', 'succeeded', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A succeeded payment must carry the provider's reference.
  constraint payment_intents_succeeded_needs_ref check (
    status <> 'succeeded' or provider_ref is not null
  )
);

-- One live intent per quote, so a retried job cannot double-charge.
create unique index if not exists payment_intents_live_quote_idx
  on public.payment_intents (quote_id)
  where status in ('requires_payment', 'pending', 'succeeded');

create index if not exists payment_intents_owner_idx
  on public.payment_intents (owner_id, created_at desc);

drop trigger if exists payment_intents_touch on public.payment_intents;
create trigger payment_intents_touch before update on public.payment_intents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- send_quote — draft → sent, owner only, and never past the expiry.
-- ---------------------------------------------------------------------------
create or replace function public.send_quote(p_quote_id uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_row public.quotes;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  update public.quotes
  set status = 'sent',
      sent_at = now()
  where id = p_quote_id
    and owner_id = v_owner
    and status = 'draft'
    and (expires_at is null or expires_at > now())
  returning * into v_row;

  if v_row.id is null then
    raise exception 'only a draft that has not expired can be sent';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_quote — the customer's acceptance, recorded once.
--
-- Service role only: the acceptance arrives from a link or a reply, handled by
-- the worker, not from the owner's own session.
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

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_payment_intent — the only way an intent is born.
-- ---------------------------------------------------------------------------
create or replace function public.create_payment_intent(p_quote_id uuid)
returns public.payment_intents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_live boolean;
  v_row public.payment_intents;
begin
  if not public.is_service_request() then
    raise exception 'payment intents are created by the worker only';
  end if;

  select * into v_quote from public.quotes where id = p_quote_id;
  if v_quote.id is null then
    raise exception 'unknown quote';
  end if;

  select payments_live into v_live
  from public.business_settings
  where owner_id = v_quote.owner_id;

  if not coalesce(v_live, false) then
    raise exception 'payments are not live for this owner';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'the customer has not accepted this quote';
  end if;

  if v_quote.amount_cents is null or v_quote.amount_cents <= 0 then
    raise exception 'the quote has no amount';
  end if;

  insert into public.payment_intents (owner_id, quote_id, lead_id, amount_cents, currency, status)
  values (v_quote.owner_id, v_quote.id, v_quote.lead_id, v_quote.amount_cents, v_quote.currency, 'requires_payment')
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.quotes enable row level security;
alter table public.payment_intents enable row level security;

drop policy if exists quotes_select on public.quotes;
create policy quotes_select on public.quotes
  for select to authenticated using (owner_id = auth.uid());

-- The owner drafts and edits quotes, but cannot mark one accepted or sent:
-- those transitions are functions with their own preconditions.
drop policy if exists quotes_insert on public.quotes;
create policy quotes_insert on public.quotes
  for insert to authenticated
  with check (owner_id = auth.uid() and status = 'draft');

drop policy if exists quotes_update on public.quotes;
create policy quotes_update on public.quotes
  for update to authenticated
  using (owner_id = auth.uid() and status = 'draft')
  with check (owner_id = auth.uid() and status = 'draft');

drop policy if exists quotes_delete on public.quotes;
create policy quotes_delete on public.quotes
  for delete to authenticated
  using (owner_id = auth.uid() and status in ('draft', 'declined', 'expired'));

drop policy if exists payment_intents_select on public.payment_intents;
create policy payment_intents_select on public.payment_intents
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.quotes from anon;
revoke all on public.payment_intents from anon;

grant select, insert, update, delete on public.quotes to authenticated;
grant select on public.payment_intents to authenticated;

-- ---------------------------------------------------------------------------
-- Execute privileges
-- ---------------------------------------------------------------------------
revoke all on function public.send_quote(uuid) from public, anon;
grant execute on function public.send_quote(uuid) to authenticated;

revoke all on function public.accept_quote(uuid, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote(uuid, text, text) to service_role;

revoke all on function public.create_payment_intent(uuid) from public, anon, authenticated;
grant execute on function public.create_payment_intent(uuid) to service_role;
