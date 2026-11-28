# Phase 9 — Audit and dry-run

Started 2026-11-28. This page records what the dry-run audit actually checks,
what was executed locally, and what could not be run because no Supabase,
search, email or Stripe credentials exist in this environment.

**Status: dry-run audit built and locally verified. A controlled live run is
blocked by missing configuration, so Phase 9 is not complete and nothing has
been sent, charged or deployed.**

Live email, discovery, automatic production and payments remain off by default.
The audit never turns them on.

## What a dry-run audit is

`audit.run` is a normal queued job. The owner starts one from **Cloud → Audit &
dry-run**, and the database creates an `audit_runs` row and queues the job. The
worker performs only reads and writes the report; it makes no provider request
and changes no customer record.

Every run is constrained to `dry_run = true` in the schema. There is no
parameter, function or handler path for a live audit.

An owner-started audit runs even while the company is paused. The queued job
carries an `ownerStarted` marker written by `start_audit_run`, and the worker
honours the pause exemption only for that marked job; every other non-system job
stays deferred.

Each check is recorded as:

| Status | Meaning |
| --- | --- |
| `pass` | The check ran and the invariant held. |
| `fail` | The check ran and found a real problem. |
| `blocked` | The check could not be completed because a provider or key is missing. Never counted as a pass. |

`finish_audit_run` derives the overall status from the checks: one `fail` means
`failed`, otherwise one `blocked` means `blocked`, otherwise `passed`.

## Checks in this phase

| Key | What it proves |
| --- | --- |
| `run_is_dry` | The report row is dry-run only and no external call was made. |
| `database_security` | Every public table has RLS, anon has no table grants, every `SECURITY DEFINER` function pins `search_path`, and no definer function is callable by anon. |
| `payment_integrity` | Every paid order has a confirmed payment, the amount and currency match, and no succeeded payment lacks a provider reference. |
| `delivery_integrity` | A delivered item has an accepted quote and a delivery message; production work has a paid order. |
| `queue_recovery` | No job is running past its lock. |
| `duplicate_sends` | No message is marked sent without a provider reference. |
| `spending_cap` | Recorded AI spend does not exceed the owner budget. |
| `live_gates` | Email, payments, live Stripe mode and automatic production are all off. |
| `provider_config` | Search, email and Stripe test credentials are present. Missing ones make this `blocked`. |
| `live_key_guard` | A live Stripe key is refused, including a restricted live key (`rk_live_…`). With no Stripe key the guard cannot be exercised, so it is `blocked`, never `pass`. |

The checks are intentionally read-only. They do not requeue stale jobs, retry a
send, create a checkout or repair data; those actions stay owner-driven.

## End-to-end evidence

The local suite runs every migration into a fresh Postgres database and seeds
two separate owners. The controlled scenarios use only this throwaway database;
no test business, contact, email, payment or deliverable exists in a live
project because there is no live project.

The first end-to-end run of the real worker and handler exposed two defects: the
audit was deferred while the company was paused, and `live_key_guard` passed
merely because no key existed. Both are fixed and covered by
`phase9_audit_test.ts`. A rerun against a fresh database with
`autonomy_mode = 'paused'` and no Stripe key produced: job **succeeded**; 10
checks; **8 pass, 0 fail, 2 blocked** (`provider_config`, `live_key_guard`);
overall **blocked**. No provider call was made.

| Roadmap step | Evidence | Result |
| --- | --- | --- |
| Real lead discovery | Requires `SEARCH_PROVIDER` and its key | **Blocked** — no provider configured; no business was invented |
| Deterministic scoring | `phase9_policy_test.ts`: same evidence gives the same score, reasons cite stored facts | Pass |
| Personalised draft | `phase9_policy_test.ts`: only stored facts, opt-out line always present, no invented price | Pass |
| Suppression and opt-out | Postgres assertions: suppression blocks drafts, sends, follow-ups and retention; opt-out stores skipped plan | Pass |
| Test sending | Requires `AGENTMAIL_API_KEY` and a verified inbox | **Blocked** — no email account, no send attempted |
| Send gates | `phase9_policy_test.ts`: provider, toggle, mode, account, verification, suppression and daily cap all fail closed | Pass |
| Reply processing | Postgres assertions: reply cancels follow-up, opt-out closes the deal and suppresses the address | Pass |
| Interested / pricing / negotiation / ready states | Owner-driven deal rows exist; not every stage transition was exercised | Partial |
| Stripe test checkout | Requires `STRIPE_SECRET_KEY` | **Blocked** — no Checkout Session was created |
| Valid signed webhook | Postgres paid-order assertions + 6 Stripe signature tests | Pass locally |
| Forged / tampered / stale webhook | HMAC tests reject a wrong secret, changed body, stale timestamp and missing header | Pass |
| Paid order | Postgres assertions: one order per quote, idempotent duplicate event, amount/currency checked | Pass |
| Production files | `production_templates_test.ts` generated real HTML, Markdown, CSV, SVG and PDF for every catalog service; example.com audit returned HTTP 200 and passed QA | Pass |
| QA failure / retry | Postgres assertions cover QA verdicts, bounded attempts and revision re-arm; the full handler was not run against a live worker | Partial |
| Delivery | Postgres assertions: link mint/revoke/expiry, delivery email link, revision from customer page | Pass |
| Retention follow-ups | Postgres assertions: receipt/review/recurring kinds, opt-out, cancellation, idempotency | Pass |
| Interrupted job recovery | Postgres assertion: an expired lock is requeued, an exhausted job becomes dead | Pass |
| Duplicates | Postgres assertions: payment reuse, duplicate Stripe event, duplicate cycle key, duplicate retention plan | Pass |
| Stop / pause | Policy test: paused owner has no loop work; scheduler not run live | Partial |
| Spending and email limits | Postgres AI-cap assertion + policy daily-cap test | Pass locally |
| App reopening | No device or emulator in this environment | **Not tested** |
| Security audit | RLS, grants, search_path, anon definers, webhook signatures, live gates | Pass locally |

## Security audit

Automated, against the migrated local database:

- All public tables have RLS enabled.
- `anon` has no table grants.
- Every `SECURITY DEFINER` function pins `search_path`.
- No `SECURITY DEFINER` function is directly executable by `anon` (trigger
  functions are excluded because the trigger machinery invokes them, not a
  caller).
- Audit check/finish/database functions are service-role only; a signed-in
  owner gets `permission denied`.
- The Stripe webhook accepts a correct HMAC and rejects a wrong secret, a
  tampered body, a timestamp older than five minutes and a missing signature.
- The live-key guard refuses both standard (`sk_live_…`) and restricted
  (`rk_live_…`) live keys, while restricted test keys pass.
- The audit report is owner-readable only; another owner sees zero rows.
- Live gates default to off, and the audit reports any that are on as a
  failure.

Code review, not a runtime assertion:

- Web pages, search results and email bodies are stored as data. They are never
  passed to a tool that can send, pay or authorize anything, and drafts/scoring
  are deterministic rather than model-driven.
- Website fetching makes one HTTPS request, refuses private network targets and
  redirects, and executes no page scripts.
- Delivery and payment pages send a no-script CSP, `frame-ancestors 'none'`,
  `no-store` and `noindex`.
- The service-role key is only read inside edge functions; the app receives the
  anon key and RLS applies to every query.

Prompt injection and browser risk were reviewed at the code level; they were
not exercised with a hostile live page because no browser or search provider is
available here.

## Executed checks

- Fresh local Postgres, all migrations: **132 assertions passed, 0 failed**
  (116 before Phase 9 + 16 Phase 9 checks).
- `deno test supabase/tests/phase9_audit_test.ts supabase/tests/phase9_policy_test.ts supabase/tests/stripe_signature_test.ts`:
  **23 passed, 0 failed** (6 audit regressions, 11 policy, 6 webhook).
- Real `runQueue` and `audit.run` end to end against a fresh local Postgres:
  **11 harness checks passed, 0 failed**, with the company paused. Both local
  suites are checked in under `supabase/tests/local/` and start their own
  throwaway Postgres when no server is configured.
- `deno run --allow-net=example.com supabase/tests/production_templates_test.ts`:
  every template passed and the live example.com audit returned HTTP 200.
- `npx tsc --noEmit`: 0.
- `deno check` on every edge function: 0.
- `npx expo export --platform android`: 0.

## Missing configuration

| Missing | What it blocks |
| --- | --- |
| Supabase project (`SUPABASE_URL`, anon key, service role) | No migration or edge function has run in a live project; the audit handler was type-checked, not executed against Supabase |
| `SEARCH_PROVIDER` + provider key | Real discovery and research |
| `AGENTMAIL_API_KEY` + verified inbox | Any controlled test send or delivery email |
| `STRIPE_SECRET_KEY` | Stripe test checkout |
| `STRIPE_WEBHOOK_SECRET` | Live webhook verification (the HMAC logic itself is tested) |
| Scheduler cron | A live company cycle |
| Android device/emulator | Visual inspection and app-reopening test |

## Cost and limits

- One audit run writes one `audit_runs` row, one queue job and one completion
  event. It makes no model call and no provider call.
- A second audit cannot be queued while one is queued or running. If its worker
  job dies, the next start closes the dead report and allows a retry.
- The audit does not change the AI budget, the email cap, the lead cap or any
  live switch.

## How to run

```bash
# Full SQL suite and the paused-audit end-to-end harness. The harness starts
# its own throwaway Postgres when none is configured and drops/recreates the
# test databases on every run.
cd supabase/tests/local
npm install
node run_all.mjs

# Pure policy and webhook tests
deno test supabase/tests/phase9_audit_test.ts supabase/tests/phase9_policy_test.ts supabase/tests/stripe_signature_test.ts

# Production generators
deno run --allow-net=example.com supabase/tests/production_templates_test.ts
```

From a configured project, apply the migration and deploy the worker, then use
**Cloud → Audit & dry-run → Run dry-run audit**. The expected first result is
`blocked` while provider keys are absent, with every locally-checkable security
and integrity check passing.
