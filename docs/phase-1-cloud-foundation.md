# Phase 1 — Cloud foundation

This phase makes NOVA OS able to run work **without the phone being open**. It adds a cloud
database, owner authentication, a persistent job queue with retries and checkpoints, a worker, a
scheduler, company memory, the CRM tables later phases need, health checks and the app-side control
surface.

It does **not** add discovery, email, sales, Stripe or production. Those are Phases 2–8, and every
one of them ships disabled.

## Baseline before this phase

The repository was a purely local app: Expo Router on the phone, `AsyncStorage` for missions,
projects, conversations, memory, activity and settings, NVIDIA NIM called directly from the device
with a keystore-stored key. No backend, no accounts, no queue, no server-side anything.

Phase 1 is additive. Nothing about the local workspace, the agents, delegation, mission execution,
memory recall or the NIM client was changed. With no cloud project configured, the app behaves
exactly as it did before and the Cloud screen simply reports `NOT CONFIGURED`.

## What was added

| Path | Purpose |
| --- | --- |
| `supabase/migrations/20261125120000_phase1_cloud_foundation.sql` | Tables, indexes, triggers, RLS, grants, new-owner bootstrap |
| `supabase/migrations/20261125120100_phase1_queue_functions.sql` | Queue, health and local-memory-sync RPCs with least-privilege grants |
| `supabase/functions/worker/index.ts` | Drains the queue for the caller's owner scope |
| `supabase/functions/scheduler/index.ts` | Cron entry point: enqueues the recovery sweep, then drains |
| `supabase/functions/health/index.ts` | Public liveness endpoint, service metadata only |
| `supabase/functions/_shared/` | HTTP, auth, Supabase client, job registry, queue loop |
| `src/lib/cloud/` | Public config, client, typed API, shared types |
| `src/store/cloud-store.tsx` | Session, health, queue and worker state |
| `src/app/cloud.tsx` | Cloud control screen |
| `.env.example` | The two public variables the app reads |

### Tables

`business_settings`, `company_memory`, `leads`, `contacts`, `lead_research`, `deals`, `agent_jobs`,
`agent_events`, `worker_heartbeats`.

Two mapping decisions worth knowing:

- The roadmap lists both *company memory* and *agent_memory*. They are one ledger,
  `company_memory`, with `scope` in `company | agent | project | customer`. Agent memory is
  `scope = 'agent'` plus `agent_id`. One ledger means one recall path and one dedupe rule.
- Phone-local project ids look like `prj_...`, so `company_memory.project_id` is `text`, not `uuid`.
  It is not a foreign key: projects still live on the phone in this phase.

### Queue semantics

- `enqueue_agent_job` is idempotent on `(owner_id, idempotency_key)`. Re-enqueueing the same key
  returns the existing job untouched.
- `claim_agent_jobs` uses `FOR UPDATE SKIP LOCKED`, so several workers cannot take the same job.
- The attempt counter increments **at claim time**. A worker that dies mid-job cannot retry forever;
  `requeue_stale_jobs` recovers expired locks and eventually marks the job `dead`.
- `fail_agent_job` backs off exponentially (5s, 10s, 20s → capped at 300s) until `max_attempts`.
- `checkpoint_agent_job` persists partial progress and extends the lock, so a resumed job continues
  instead of restarting.
- While `business_settings.autonomy_mode = 'paused'`, non-`system.*` jobs are **released**, not
  failed: they return to the queue after ten minutes with no attempt spent.

### What the app is allowed to do

The app can read and write its own rows, enqueue, cancel its own jobs, read health and import its
local memory. It **cannot** claim, complete or fail a job — those functions are granted to
`service_role` only. A forged client cannot mark work as succeeded.

## Setup

1. Create a project at [supabase.com](https://supabase.com).
2. Link and push the schema from a machine with the CLI:

   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

3. Set the worker secret and deploy the functions:

   ```bash
   npx supabase secrets set WORKER_SECRET="$(openssl rand -hex 32)"
   npx supabase functions deploy health worker scheduler
   ```

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the runtime; do not set them
   yourself. `verify_jwt = false` is intentional in `supabase/config.toml` — each function
   authenticates its own caller.

4. Add the public values to the app and restart Expo with a cleared cache:

   ```bash
   cp .env.example .env     # then fill in the URL and anon key
   npx expo start -c
   ```

5. Turn on the scheduler so work advances while the phone is closed. In the Supabase dashboard,
   create a cron job that POSTs to
   `https://<your-project-ref>.supabase.co/functions/v1/scheduler` every 5 minutes with the header
   `x-worker-secret: <WORKER_SECRET>` and an empty JSON body. Alternatively, with `pg_cron` and
   `pg_net` enabled:

   ```sql
   select cron.schedule('nova-scheduler', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://<your-project-ref>.supabase.co/functions/v1/scheduler',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-worker-secret', '<WORKER_SECRET>'
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 30000
     );
   $$);
   ```

   Prefer a dashboard secret or Vault over pasting the literal into SQL: `cron.job` is readable by
   the `postgres` role. Until the cron exists, the app's **Run worker now** button exercises the same
   code path.

## Verify it

In the app: System → Cloud.

1. **Create owner account.** A `business_settings` row appears and company memory contains one
   pinned objective, created by the `on_auth_user_created` trigger.
2. **Queue a test job.** One `agent_jobs` row, status `queued`, attempt `0/3`.
3. **Run worker now.** The job becomes `succeeded`, an `agent_events` row is written, and the worker
   heartbeat shows `alive`.
4. **Import local memory.** Counts come back as `inserted` / `skipped`; running it twice inserts
   nothing the second time. Local memories are untouched.
5. **Set the company to Paused**, queue a `memory.remember` job, run the worker. The job returns to
   `queued` with attempt `0/3` and the event log says it was deferred.
6. **Signed out**, a direct `select` on `leads` with the anon key returns nothing.

Type check: `npm run typecheck`.

## Limits of this phase

- The edge functions have not been executed against a live project here (no project credentials in
  this environment), and no automated test covers the SQL. The schema was written against Postgres
  15 semantics; `supabase db push` is the first real execution.
- Storage buckets, email, payments and production are not present. `payments_live` is `false` and
  there is no UI that sets it.
- Memory import is one-way and manual by design. There is no automatic mirroring and no conflict
  resolution.
- `business_settings` caps (`daily_lead_cap`, `daily_email_cap`, `ai_budget_cents`) exist and are
  enforced nowhere yet, because nothing in this phase spends or sends anything.

## Next

Phase 2 — lead discovery: a search provider, ATLAS discovery, STERLING scoring with sources and
timestamps, and the leads UI on top of the CRM foundation already in place.
