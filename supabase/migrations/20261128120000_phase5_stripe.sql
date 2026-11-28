-- ============================================================================
-- NOVA OS — Phase 5: Stripe
--
-- The roadmap rules this file exists to enforce:
--   * Checkout is created only for a purchase-ready deal: an accepted quote,
--     payments switched on by the owner, and a positive amount.
--   * A payment counts only when Stripe's signed webhook says so. A screenshot,
--     an email claim or a model assertion cannot write a paid row.
--   * An order is created only from a verified payment, exactly once.
--   * Live mode is off by default; test mode is the default surface.
--
-- Nothing here calls Stripe. The edge functions do, with the secret key held in
-- Supabase secrets; this file only decides what may be recorded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Settings: Stripe live mode is a separate, owner-controlled switch.
-- ---------------------------------------------------------------------------
alter table public.business_settings
  add column if not exists stripe_live_mode boolean not null default false;

comment on column public.business_settings.stripe_live_mode is
  'Off by default. Even with a live Stripe key configured, checkout creation refuses live mode until the owner turns this on after a passing test run.';

-- ---------------------------------------------------------------------------
-- payment_intents — checkout state on top of the Phase 4 record.
-- ---------------------------------------------------------------------------
alter table public.payment_intents
  add column if not exists checkout_session_id text,
  add column if not exists checkout_url text,
  add column if not exists checkout_expires_at timestamptz,
  add column if not exists paid_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_cents integer not null default 0,
  add column if not exists provider_status text;

alter table public.payment_intents
  drop constraint if exists payment_intents_status_check;

alter table public.payment_intents
  add constraint payment_intents_status_check check (
    status in (
      'requires_payment',   -- awaiting a checkout
      'checkout_created',   -- a Stripe Checkout Session is open
      'pending',            -- Stripe reported an async payment in flight
      'succeeded',          -- Stripe's signed webhook reported it paid
      'failed',
      'cancelled',
      'refunded',
      'partially_refunded'
    )
  );

alter table public.payment_intents
  drop constraint if exists payment_intents_refund_within_amount_check;
alter table public.payment_intents
  add constraint payment_intents_refund_within_amount_check
  check (refunded_cents >= 0 and refunded_cents <= amount_cents);

-- A refunded payment still holds its quote: a second charge is not allowed.
-- Only a failed or cancelled attempt leaves room for a fresh checkout.
drop index if exists public.payment_intents_live_quote_idx;
create unique index if not exists payment_intents_live_quote_idx
  on public.payment_intents (quote_id)
  where status not in ('failed', 'cancelled');

create unique index if not exists payment_intents_checkout_session_idx
  on public.payment_intents (checkout_session_id)
  where checkout_session_id is not null;

-- ---------------------------------------------------------------------------
-- stripe_events — idempotency and evidence for every webhook we accepted.
-- ---------------------------------------------------------------------------
create table if not exists public.stripe_events (
  id text primary key,
  type text not null check (length(btrim(type)) > 0),
  owner_id uuid references auth.users (id) on delete set null,
  intent_id uuid references public.payment_intents (id) on delete set null,
  matched boolean not null default true,
  note text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- orders — born only from a verified payment.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  quote_id uuid not null unique references public.quotes (id) on delete cascade,
  payment_intent_id uuid not null unique references public.payment_intents (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  deal_id uuid references public.deals (id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd' check (currency in ('usd')),
  status text not null default 'paid'
    check (status in ('paid', 'fulfilled', 'refunded', 'partially_refunded')),
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_owner_idx
  on public.orders (owner_id, paid_at desc);

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.set_updated_at();

alter table public.orders enable row level security;

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
  for select to authenticated using (owner_id = auth.uid());

revoke all on public.orders from anon;
grant select on public.orders to authenticated;

-- ---------------------------------------------------------------------------
-- expenses — real costs the owner records, so profit is not a guess.
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  category text not null default 'other'
    check (category in ('software', 'ads', 'contractor', 'tools', 'other')),
  note text not null check (length(btrim(note)) > 0),
  amount_cents integer not null check (amount_cents > 0),
  incurred_on date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_owner_idx
  on public.expenses (owner_id, incurred_on desc);

drop trigger if exists expenses_touch on public.expenses;
create trigger expenses_touch before update on public.expenses
  for each row execute function public.set_updated_at();

alter table public.expenses enable row level security;

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses
  for delete to authenticated using (owner_id = auth.uid());

revoke all on public.expenses from anon;
grant select, insert, update, delete on public.expenses to authenticated;

-- ---------------------------------------------------------------------------
-- create_checkout_intent — the only door to a Stripe checkout.
--
-- Returns the one live intent for the quote, creating it when none exists. The
-- acceptance and the owner's live-payments switch are re-checked here, so a
-- stale screen cannot start a checkout for a draft.
-- ---------------------------------------------------------------------------
create or replace function public.create_checkout_intent(p_quote_id uuid)
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
    raise exception 'checkout is created by the payments service only';
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

  if v_quote.expires_at is not null and v_quote.expires_at <= now() then
    raise exception 'this quote has expired';
  end if;

  select * into v_row
  from public.payment_intents
  where quote_id = v_quote.id
    and status not in ('failed', 'cancelled')
  order by created_at desc
  limit 1;

  if v_row.id is not null then
    if v_row.status in ('succeeded', 'refunded', 'partially_refunded') then
      raise exception 'this quote is already paid';
    end if;
    if v_row.provider <> 'stripe' then
      update public.payment_intents
      set provider = 'stripe'
      where id = v_row.id
      returning * into v_row;
    end if;
    return v_row;
  end if;

  insert into public.payment_intents (
    owner_id, quote_id, lead_id, provider, amount_cents, currency, status
  )
  values (
    v_quote.owner_id, v_quote.id, v_quote.lead_id, 'stripe',
    v_quote.amount_cents, v_quote.currency, 'requires_payment'
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- attach_checkout_session — stores the session Stripe actually returned.
-- ---------------------------------------------------------------------------
create or replace function public.attach_checkout_session(
  p_intent_id uuid,
  p_session_id text,
  p_url text,
  p_expires_at timestamptz default null
)
returns public.payment_intents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session text := btrim(coalesce(p_session_id, ''));
  v_url text := btrim(coalesce(p_url, ''));
  v_row public.payment_intents;
begin
  if not public.is_service_request() then
    raise exception 'checkout sessions are attached by the payments service only';
  end if;

  if length(v_session) < 6 then
    raise exception 'a Stripe checkout session id is required';
  end if;

  if v_url !~* '^https://' then
    raise exception 'a checkout link must be an https URL';
  end if;

  select * into v_row from public.payment_intents where id = p_intent_id;
  if v_row.id is null then
    raise exception 'unknown payment record';
  end if;

  if v_row.status in ('succeeded', 'refunded', 'partially_refunded') then
    raise exception 'this payment is already paid';
  end if;

  if v_row.checkout_session_id is not null
     and v_row.checkout_session_id <> v_session
     and v_row.status = 'checkout_created'
     and (v_row.checkout_expires_at is null or v_row.checkout_expires_at > now()) then
    raise exception 'a checkout session is already open for this payment';
  end if;

  update public.payment_intents
  set provider = 'stripe',
      status = 'checkout_created',
      checkout_session_id = v_session,
      checkout_url = v_url,
      checkout_expires_at = p_expires_at,
      provider_status = 'open'
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_stripe_event — the single write path for a verified Stripe webhook.
--
-- The edge function verifies the signature before calling this. Here we
-- deduplicate by Stripe event id, match the intent by session or payment-intent
-- reference, verify the amount and currency, and only then move status.
-- ---------------------------------------------------------------------------
create or replace function public.record_stripe_event(
  p_event_id text,
  p_type text,
  p_checkout_session_id text default null,
  p_provider_ref text default null,
  p_amount_cents integer default null,
  p_currency text default null,
  p_outcome text default null,
  p_refunded_cents integer default null,
  p_payload jsonb default '{}'::jsonb,
  p_intent_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id text := btrim(coalesce(p_event_id, ''));
  v_type text := btrim(coalesce(p_type, ''));
  v_inserted integer := 0;
  v_intent public.payment_intents;
  v_order public.orders;
  v_refund integer;
begin
  if not public.is_service_request() then
    raise exception 'stripe events are recorded by the payment webhook only';
  end if;

  if v_event_id = '' then
    raise exception 'a Stripe event id is required';
  end if;
  if v_type = '' then
    raise exception 'a Stripe event type is required';
  end if;
  if p_outcome is not null
     and p_outcome not in ('paid', 'pending', 'failed', 'cancelled', 'refunded', 'partially_refunded') then
    raise exception 'unknown Stripe outcome "%"', p_outcome;
  end if;

  insert into public.stripe_events (id, type, payload)
  values (v_event_id, v_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return jsonb_build_object('ok', true, 'duplicate', true, 'eventId', v_event_id);
  end if;

  select * into v_intent
  from public.payment_intents
  where (p_checkout_session_id is not null and p_checkout_session_id <> ''
         and checkout_session_id = p_checkout_session_id)
     or (p_provider_ref is not null and p_provider_ref <> ''
         and provider_ref = p_provider_ref)
     or (p_intent_id is not null and id = p_intent_id)
  order by created_at desc
  limit 1;

  if v_intent.id is null then
    update public.stripe_events
    set matched = false, note = 'no payment record matches this event'
    where id = v_event_id;

    return jsonb_build_object('ok', true, 'matched', false, 'eventId', v_event_id);
  end if;

  update public.stripe_events
  set owner_id = v_intent.owner_id, intent_id = v_intent.id
  where id = v_event_id;

  -- Amount and currency have to agree with what we asked the customer to pay.
  if p_amount_cents is not null and p_amount_cents <> v_intent.amount_cents then
    update public.stripe_events
    set matched = false, note = 'amount mismatch'
    where id = v_event_id;

    return jsonb_build_object(
      'ok', true, 'matched', false, 'reason', 'amount_mismatch',
      'expected', v_intent.amount_cents, 'received', p_amount_cents
    );
  end if;

  if p_currency is not null and lower(p_currency) <> lower(v_intent.currency) then
    update public.stripe_events
    set matched = false, note = 'currency mismatch'
    where id = v_event_id;

    return jsonb_build_object(
      'ok', true, 'matched', false, 'reason', 'currency_mismatch',
      'expected', v_intent.currency, 'received', p_currency
    );
  end if;

  if p_outcome is null then
    return jsonb_build_object('ok', true, 'matched', true, 'recorded', false, 'eventId', v_event_id);
  end if;

  if p_outcome = 'paid' then
    if v_intent.status in ('succeeded', 'refunded', 'partially_refunded') then
      select * into v_order from public.orders where payment_intent_id = v_intent.id;
      return jsonb_build_object(
        'ok', true, 'matched', true, 'paid', true,
        'alreadyPaid', true, 'orderId', v_order.id
      );
    end if;

    update public.payment_intents
    set status = 'succeeded',
        provider = 'stripe',
        provider_ref = coalesce(
          nullif(btrim(coalesce(p_provider_ref, '')), ''),
          nullif(btrim(coalesce(p_checkout_session_id, '')), ''),
          provider_ref
        ),
        checkout_session_id = coalesce(checkout_session_id, nullif(btrim(coalesce(p_checkout_session_id, '')), '')),
        paid_at = coalesce(paid_at, now()),
        failed_at = null,
        provider_status = 'paid'
    where id = v_intent.id
    returning * into v_intent;

    insert into public.orders (
      owner_id, quote_id, payment_intent_id, lead_id, deal_id,
      amount_cents, currency, status, paid_at
    )
    values (
      v_intent.owner_id, v_intent.quote_id, v_intent.id, v_intent.lead_id,
      (select deal_id from public.quotes where id = v_intent.quote_id),
      v_intent.amount_cents, v_intent.currency, 'paid', coalesce(v_intent.paid_at, now())
    )
    on conflict (payment_intent_id) do nothing
    returning * into v_order;

    if v_order.id is null then
      select * into v_order from public.orders where payment_intent_id = v_intent.id;
    end if;

    return jsonb_build_object(
      'ok', true, 'matched', true, 'paid', true,
      'alreadyPaid', false, 'orderId', v_order.id,
      'intentId', v_intent.id, 'amountCents', v_intent.amount_cents
    );
  end if;

  if p_outcome = 'pending' then
    if v_intent.status not in ('succeeded', 'refunded', 'partially_refunded', 'failed', 'cancelled') then
      update public.payment_intents
      set status = 'pending', provider_status = 'pending'
      where id = v_intent.id;
    end if;
    return jsonb_build_object('ok', true, 'matched', true, 'pending', true, 'intentId', v_intent.id);
  end if;

  if p_outcome = 'failed' then
    if v_intent.status not in ('succeeded', 'refunded', 'partially_refunded') then
      update public.payment_intents
      set status = 'failed', failed_at = now(), provider_status = 'failed'
      where id = v_intent.id;
    end if;
    return jsonb_build_object('ok', true, 'matched', true, 'failed', true, 'intentId', v_intent.id);
  end if;

  if p_outcome = 'cancelled' then
    if v_intent.status not in ('succeeded', 'refunded', 'partially_refunded') then
      update public.payment_intents
      set status = 'cancelled', provider_status = 'cancelled'
      where id = v_intent.id;
    end if;
    return jsonb_build_object('ok', true, 'matched', true, 'cancelled', true, 'intentId', v_intent.id);
  end if;

  -- Refund outcomes. A refund for a payment that was never recorded as paid is
  -- evidence of a mismatch, not a reason to invent a payment.
  if v_intent.status not in ('succeeded', 'refunded', 'partially_refunded') then
    update public.stripe_events
    set matched = false, note = 'refund for an unpaid record'
    where id = v_event_id;

    return jsonb_build_object('ok', true, 'matched', false, 'reason', 'refund_before_payment');
  end if;

  v_refund := greatest(
    0,
    least(v_intent.amount_cents, coalesce(p_refunded_cents, v_intent.amount_cents))
  );
  v_refund := greatest(v_intent.refunded_cents, v_refund);

  update public.payment_intents
  set refunded_cents = v_refund,
      refunded_at = now(),
      status = case when v_refund >= amount_cents then 'refunded' else 'partially_refunded' end,
      provider_status = case when v_refund >= amount_cents then 'refunded' else 'partially_refunded' end
  where id = v_intent.id
  returning * into v_intent;

  update public.orders
  set status = case
      when v_refund >= amount_cents then 'refunded'
      else 'partially_refunded'
    end
  where payment_intent_id = v_intent.id
  returning * into v_order;

  return jsonb_build_object(
    'ok', true, 'matched', true, 'refunded', true,
    'refundedCents', v_refund, 'intentId', v_intent.id, 'orderId', v_order.id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- finance_summary — revenue, refunds, pending, costs and profit for the owner.
--
-- Revenue counts only verified payments; pending is money the customer has not
-- paid. Profit subtracts recorded expenses and the AI spend the owner has
-- already incurred.
-- ---------------------------------------------------------------------------
create or replace function public.finance_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_pay record;
  v_expenses integer := 0;
  v_ai integer := 0;
  v_orders integer := 0;
begin
  if v_owner is null then
    raise exception 'sign in required';
  end if;

  select
    coalesce(sum(case when status in ('succeeded', 'refunded', 'partially_refunded')
      then amount_cents else 0 end), 0)::int as gross_cents,
    coalesce(sum(case when status in ('succeeded', 'refunded', 'partially_refunded')
      then amount_cents - refunded_cents else 0 end), 0)::int as net_cents,
    coalesce(sum(case when status in ('succeeded', 'refunded', 'partially_refunded')
      then refunded_cents else 0 end), 0)::int as refunded_cents,
    coalesce(sum(case when status in ('requires_payment', 'checkout_created', 'pending')
      then amount_cents else 0 end), 0)::int as pending_cents,
    count(*) filter (where status in ('requires_payment', 'checkout_created', 'pending'))::int as pending_count,
    count(*) filter (where status in ('succeeded', 'refunded', 'partially_refunded'))::int as paid_count,
    count(*) filter (where status in ('failed', 'cancelled'))::int as failed_count
  into v_pay
  from public.payment_intents
  where owner_id = v_owner;

  select coalesce(sum(amount_cents), 0)::int into v_expenses
  from public.expenses
  where owner_id = v_owner;

  select coalesce(ai_spend_cents, 0)::int into v_ai
  from public.business_settings
  where owner_id = v_owner;

  select count(*)::int into v_orders
  from public.orders
  where owner_id = v_owner;

  return jsonb_build_object(
    'grossRevenueCents', v_pay.gross_cents,
    'netRevenueCents', v_pay.net_cents,
    'refundedCents', v_pay.refunded_cents,
    'pendingCents', v_pay.pending_cents,
    'expensesCents', v_expenses,
    'aiSpendCents', v_ai,
    'profitCents', v_pay.net_cents - v_expenses - v_ai,
    'pendingCount', v_pay.pending_count,
    'paidCount', v_pay.paid_count,
    'failedCount', v_pay.failed_count,
    'orderCount', v_orders,
    'paymentsLive', coalesce((select payments_live from public.business_settings where owner_id = v_owner), false),
    'stripeLiveMode', coalesce((select stripe_live_mode from public.business_settings where owner_id = v_owner), false)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges — service-role only for the checkout and webhook paths.
-- ---------------------------------------------------------------------------
revoke all on function public.create_checkout_intent(uuid) from public, anon, authenticated;
grant execute on function public.create_checkout_intent(uuid) to service_role;

revoke all on function public.attach_checkout_session(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.attach_checkout_session(uuid, text, text, timestamptz)
  to service_role;

revoke all on function public.record_stripe_event(text, text, text, text, integer, text, text, integer, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.record_stripe_event(text, text, text, text, integer, text, text, integer, jsonb, uuid)
  to service_role;

revoke all on function public.finance_summary() from public, anon;
grant execute on function public.finance_summary() to authenticated;
