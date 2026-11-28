# Phase 7 — Delivery and retention

Completed 2026-11-28. This is roadmap Phase 7, separate from the older
`docs/phase-6-production.md` delivery-tracking notes.

## What a delivery is

A delivery is a customer-specific, expiring link to the files SENTINEL passed —
not a screenshot, not a public bucket URL, and not a status someone typed.

1. Production finishes with a `ready` job and stored files.
2. The owner queues `relay.send_delivery` from Delivery, or mints a link without
   sending.
3. The worker creates a random 32-byte token. Only its SHA-256 hash, an expiry
   and the deliverable id are stored in `delivery_links`; the plaintext token is
   written once into the delivery email body.
4. The customer opens `/functions/v1/delivery?token=…`. The function resolves the
   hash, checks expiry/revocation, loads the current ready version and signs each
   file for 15 minutes.
5. The worker marks the deliverable delivered only after AgentMail returned a
   real message id. A failed send marks the message failed and leaves the
   delivery open for a retry.

`delivery_links` is owner-readable, worker-writable, and revocable with
`revoke_delivery_link`. An unknown, expired and revoked token all render the same
generic page, so the link cannot be used to discover deliveries.

The delivery email is transactional: it does not consume the outreach daily cap
and is not blocked by a marketing opt-out, because the customer has already paid
for the work. It still requires the owner's email switch, a configured provider
and a verified sending account.

## Revisions

`request_deliverable_revision` already enforced the included allowance. Phase 7
adds the missing follow-through: a trigger re-arms the quote's production job
(`queued`, attempts reset to 0, revision note stored), records the deliverable on
the job and queues a new `forge.produce` run with a revision-specific idempotency
key. FORGE writes version `n+1`, SENTINEL checks it, and the owner can deliver
again. The customer's revision note is kept in the job's QA notes and in the
deliverable.

## Retention and customer history

After a delivery has a sent email, Delivery offers **Retention +30d**. It calls
`schedule_follow_up(kind => 'retention')` against that sent message. The existing
rules still apply: a reply, bounce or suppression cancels it, and a due retention
follow-up becomes an owner-approved draft — it is never sent automatically.

`customer_history()` returns one row per customer with an order: order count,
paid cents, delivery count, accepted count and last delivery. It is
`security definer` but filters `owner_id = auth.uid()`, and execution is granted
to authenticated only.

## Checks

- Fresh local Postgres, all migrations: **86 assertions passed, 0 failed** (68
  existing + 18 Phase 7 assertions covering link minting, token resolution,
  revocation, expiry, revision re-arming, revision allowance, customer history,
  delivery-message idempotency and RLS).
- `npx tsc --noEmit` exit 0.
- `deno check` on every edge function (including the new `delivery` function)
  exit 0.

## Not verified here

There is no Supabase project, AgentMail key or customer in this environment.
The link page, signed storage URLs, real delivery email, AgentMail send and the
retention scheduling against a live project have not been executed. The SQL
functions and RLS were executed against the local Postgres harness; the HTTP
page and the provider call were only type-checked.

The link page does not include a customer acceptance button; acceptance remains
an owner decision in the app, as built in the earlier delivery phase.
