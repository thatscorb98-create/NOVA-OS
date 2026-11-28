# Phase 2 (discovery) and Phase 3 (outreach)

This page records what the two phases actually enforce, what the SQL suite
asserts, and what is still blocked. It is evidence, not a roadmap.

## Phase 2 — discovery

| Rule | How it is enforced |
| --- | --- |
| No invented businesses | A discovery run only inserts what a configured search provider returned. With no `SEARCH_PROVIDER` key the handler throws `ProviderNotConfigured` and the run records zero results. |
| No invented prices | `service_catalog` seeds six real service definitions with `price_cents = null`, `enabled = false`. A CHECK constraint refuses to enable an unpriced service. |
| One lead per domain | Unique index on `(owner_id, domain)`; a duplicate returns `23505` and is treated as "already known". |
| One open deal per lead | Partial unique index on `(owner_id, lead_id) where stage not in ('won','lost')`. |
| Deterministic scoring | `sterling.score` is arithmetic over stored signals — no model call — so the same lead always scores the same and the reasons are auditable. |
| Owner isolation | RLS on every table, plus owner filters inside each handler. |

Handlers: `atlas.discover`, `atlas.research`, `sterling.score`.

## Phase 3 — outreach

Email ships switched off, and three independent things have to be true before a
message can leave the building.

**1. The schema refuses to look sent.**

- `outreach_messages.status` only moves `draft → approved → sending → sent`.
- `constraint outreach_messages_sent_needs_id` rejects `status = 'sent'` without
  a `provider_message_id`, so a send that never happened cannot be recorded.
- The owner's RLS write policy only covers rows in `draft`; every transition runs
  through a function. `claim_outreach_message`, `mark_outreach_sent` and
  `mark_outreach_failed` are service-role only.
- `email_accounts` cannot be enabled without a from address.

**2. Drafts contain only stored facts.**

`echo.draft_email` builds the body from the lead's own row, its stored scoring
reasons, the contact's public address and the owner's catalog entry. There is no
model call and no generated claim about the business. The unsubscribe line is
part of every draft.

**3. Every send re-checks every gate.**

`relay.send_email` calls `sendBlockedReason` immediately before the provider
request. Any one of these blocks it, with a stored reason and no attempt
consumed:

- `AGENTMAIL_API_KEY` missing
- `business_settings.email_enabled = false`
- autonomy mode below `outreach`
- sending account disabled or unverified
- address on the suppression list
- daily cap of zero, or already reached

Bounces, complaints and unsubscribes arriving at the webhook go onto the
suppression list, which also cancels that address's open drafts.

Handlers: `echo.draft_email`, `relay.send_email`. Webhook: `supabase/functions/webhook`.

## What the SQL suite asserts

`node phase3.mjs` applies all four migrations to a real Postgres instance and
runs 31 assertions, including the Phase 1 and Phase 2 regressions. The Phase 3
ones:

- a sender cannot be enabled without a from address (`23514`)
- a message cannot be stored as `sent` without a provider id (`23514`)
- a second open message for the same lead is rejected (`23505`)
- the owner can approve a draft, and the approval is persisted
- the owner cannot claim a message for sending (`42501`)
- `mark_outreach_sent` refuses an empty provider id
- a successful send records `status = sent` and the provider id
- suppression cancels the open message and is idempotent across case
- another owner sees no messages and no suppression rows

## Follow-ups and routine replies

The completion pass added the parts of Phase 3 that were missing from the first
build:

- `follow_ups` schedules a check-in against a message that was actually sent.
  `schedule_follow_up` refuses a draft, an unsent message, a past date or a
  suppressed address. `cancel_follow_up` is the owner's stop button.
- A reply, bounce or cancellation on the original message cancels its open
  follow-up automatically, and adding an address to the suppression list cancels
  every open follow-up to it.
- When a follow-up is due, the owner queues `echo.draft_follow_up`. It writes a
  short, individually addressed draft from the stored facts and marks the
  schedule `drafted`; it sends nothing.
- A real reply can be turned into a `closer.draft_reply` draft. The intent label
  chooses a routine response, the lead's own name and the company name fill it
  in, and the result waits in Outreach for approval. An opt-out produces no
  draft.

## What the follow-up suite asserts

- an owner can schedule a follow-up on a sent message
- a second open follow-up for the same message is refused
- another owner cannot schedule or read it
- a reply cancels the open follow-up
- suppression cancels a scheduled follow-up

## Not done, and why

- **No live send has ever run.** There is no Supabase project, no
  `AGENTMAIL_API_KEY` and no search key, so the provider contract in
  `providers/agentmail.ts` is written against the documented API but has not been
  exercised against the live service.
- **No model-written replies.** CLOSER's drafts are deterministic templates from
  stored facts, not NVIDIA NIM output; the server has no model key. The owner
  approves every one, and sending still needs the provider and all the gates.
- **The outreach screen cannot compose a message from scratch.** It reviews,
  approves, schedules follow-ups and drafts routine replies; the text still
  starts from ECHO's stored-facts draft.
