# Phase 4 — quotes and payment intents

The roadmap rule: **payment creation is permitted only after the customer
expressly accepts.** This phase enforces it in the database rather than in the
handler, so no code path can skip it.

## The chain

`draft → sent → accepted → payment intent`

- `send_quote` is owner-only and refuses a draft whose expiry has passed.
- `accept_quote` is service-role only, requires a sent and unexpired quote, and
  records `accepted_at`, `accepted_via` and who accepted.
- `create_payment_intent` refuses unless the quote is accepted, the amount is
  positive and `business_settings.payments_live` is true.

Nothing charges. An intent starts as `requires_payment`, and `succeeded` is
rejected without a provider reference, so a payment that never happened cannot
be recorded as one.

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

- No provider integration. `provider` is `none` until a Stripe key exists, and
  there is no charge call anywhere in the codebase.
- No quote screen yet. The tables and functions are callable and tested; the app
  has no UI for composing or sending a quote.
- No public acceptance endpoint. Acceptance is a service-role function waiting for
  a signed link handler.
