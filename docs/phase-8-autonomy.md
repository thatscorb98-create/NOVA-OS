# Phase 8 — Autonomous company loop

Completed 2026-11-28. This is roadmap Phase 8: a server-side operating loop that
reviews the company and advances the next real task without the phone being open.

## What runs

`nova.orchestrate` is a normal queued job, so it gets the Phase 1 queue's
`SKIP LOCKED` claim, five-minute lock, attempt budget, backoff, checkpoints and
stale-lock recovery. The scheduler enqueues one cycle per owner per minute
(`nova_loop:<minute bucket>`), skips a paused company, and skips an owner who
already has a queued or running cycle. Nothing on the phone is required.

Each cycle:

1. calls `nova_loop_snapshot()` — one owner-scoped read of settings, queue, CRM,
   deals, email, production, delivery, orders and retention state;
2. chooses **one** next action in this order;
3. enqueues that action with an idempotency key;
4. writes a `company_cycles` row with the decision, counts and job id, then logs
   an `agent_events` entry.

| Priority | Condition | Queued job |
| --- | --- | --- |
| 1 | A follow-up is due | `echo.draft_follow_up` |
| 2 | A reply has no reply draft | `closer.draft_reply` |
| 3 | A paid delivery passed QA and is unsent | `relay.send_delivery` |
| 4 | A paid production job is queued with no worker already on it | `forge.produce` |
| 5 | An approved message is waiting | `relay.send_email` |
| 6 | A delivered customer has no retention plan | `relay.plan_retention` |
| 7 | A qualified lead with a real contact has no outreach | `echo.draft_email` |
| 8 | Nothing else, discovery armed and under the daily lead cap | `atlas.discover` |
| — | Nothing to do | records `idle` |

One action per cycle is deliberate. Every step is visible, a failure cannot
cascade into several downstream actions, and the next cycle sees the result.

## What it will not do

- **No quotes, payments or checkouts.** `relay.create_payment_intent` is not in
  the loop. A quote and a checkout require the customer's explicit acceptance and
  the owner's payments switch; those remain owner actions in Quotes.
- **No purchases or upgrades.** There is no code path that buys, subscribes or
  upgrades a service, and `record_ai_spend` refuses to take AI spend past
  `ai_budget_cents` (zero means no paid AI spend at all). The current handlers
  make no paid model calls, so the loop cannot spend anything today.
- **No sends when a gate is closed.** Email still needs the owner's switch, a
  mode of `outreach` or higher, a verified sender, no suppression and room under
  the daily cap. A closed gate records a `blocked` cycle with the reason instead
  of pretending to work.
- **No unbounded retries.** Dead jobs are reported, not resurrected. Provider
  failures keep their existing attempt budget and end in `needs_attention` or
  `dead` for the owner to inspect.
- **No duplicate production.** The snapshot only offers a queued production job
  when no `forge.produce`/`sentinel.qa` job is already queued or running for it,
  and the loop uses the same `forge:<job>:v<version>` key as the order trigger.

## Data

`company_cycles` is the loop's checkpoint trail, unique on
`(owner_id, cycle_key)`, readable by its owner only.

`nova_loop_snapshot()` is `security definer` but every count and every `next`
id filters `owner_id = auth.uid()`. It returns the mode, feature switches, caps,
AI budget/spend, counts and the exact next row ids.

`record_company_cycle` and `record_ai_spend` are service-role only. Neither can
write for another owner from the app.

The Cloud screen shows the live loop counts, the AI budget, the last cycles and
their decisions, and a **Run company cycle** button that queues a manual cycle
and drains the queue. The **Company mode** chips stop the loop at `paused`.

## Checks

- Fresh local Postgres, all migrations: **112 assertions passed, 0 failed**
  (86 existing + 26 new). The new assertions cover:
  - receipt, review and recurring follow-ups scheduled from a sent delivery;
  - one per kind, idempotent re-scheduling, another owner refused;
  - suppression cancelling all three kinds, and re-scheduling after it is lifted;
  - customer revision from a hashed delivery token, note and revision count
    stored, expired link refused, a second open revision refused;
  - revoking every live link for a delivery and another owner refused;
  - the loop snapshot for two owners and for the service-role worker, an owner
    refused another owner's snapshot, cycle recording and duplicate keys, RLS,
    and the AI budget refusing overspend.
- `npx tsc --noEmit` exit 0.
- `deno check` on every edge function (including the scheduler and the new
  orchestrator module) exit 0.
- `npx expo export --platform android` exit 0.

## Not verified here

There is no Supabase project, scheduler cron, search key, AgentMail key or
Stripe key in this environment. The orchestration handler and the scheduler
were type-checked and their SQL was executed against local Postgres, but no
cycle has run against a live project, no cron has fired, and no email, payment,
production or delivery has been produced by the loop. The phone's autonomous
dashboard has not been viewed on a device.

Phase 9 (audit and dry-run) is the next phase and has not started.
