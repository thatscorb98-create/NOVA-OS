# Phase 4 — quotes, acceptance links and payment records

The roadmap rule: **payment creation is permitted only after the customer
expressly accepts.** It is enforced in the database rather than in the handler,
so no code path can skip it.

## The chain

`draft → sent → accepted → payment record`

- `send_quote` is owner-only and refuses a draft whose expiry has passed.
- The acceptance link carries an HMAC over the quote id and an expiry time
  (`supabase/functions/_shared/quote-link.ts`). The signing secret is a function
  secret (`QUOTE_LINK_SECRET`, falling back to `WORKER_SECRET`) and never reaches
  the app.
- `accept_quote` is service-role only, requires a sent and unexpired quote, and
  records `accepted_at`, `accepted_via` and who accepted. It also moves the deal
  to `ready_to_purchase`.
- `create_payment_intent` refuses unless the quote is accepted, the amount is
  positive and `business_settings.payments_live` is true.

Nothing charges. A record starts as `requires_payment`, and `succeeded` is
rejected without a provider reference, so a payment that never happened cannot be
recorded as one. `relay.record_payment` stores a provider's real result and needs
that reference for `succeeded`.

## What the app does

`src/app/quotes.tsx`:

- writes a draft quote against a researched or qualified lead, with an amount the
  owner types — NOVA never guesses a price
- releases a draft (`send_quote`)
- mints a signed acceptance link for a sent quote and shares it
- shows accepted quotes and their payment records
- has the payments switch, which is off by default

## What the SQL suite asserts

- a quote cannot be worth zero (`23514`)
- a draft cannot be accepted
- the owner can send a draft quote
- a payment needs an accepted quote, for the app and for the worker
- payments stay off until the owner switches them live
- an accepted quote yields an intent for exactly its own amount
- a second live intent for the same quote is rejected (`23505`)
- `succeeded` needs a provider reference (`23514`)
- the app cannot mint an intent
- another owner sees no quotes and no intents

## What is not built

- No payment provider integration in this phase. `provider` starts as `none` and
  an intent only records what is owed. Stripe checkout is
  [`phase-5-stripe.md`](phase-5-stripe.md); the app itself still makes no charge
  call and never collects card details.
- No invoice PDF, no receipts, no refunds. Delivery is tracked separately in
  [`phase-6-production.md`](phase-6-production.md).
- The acceptance page was exercised by the SQL function and inspected as code;
  it has not been served from a deployed project, because no Supabase project is
  configured for this repository yet.
