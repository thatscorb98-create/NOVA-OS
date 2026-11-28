# Local database verification

Two throwaway suites run every NOVA OS migration against fresh databases and
exercise the real worker and audit handler:

| Suite | File | What it proves |
| --- | --- | --- |
| Postgres suite | `postgres_suite.mjs` | 132 assertions across migrations, RLS, queue, payments, production, delivery, retention, autonomy and the Phase 9 audit. |
| Paused-audit E2E | `audit_paused_e2e.ts` | The real `start_audit_run` → `runQueue` → `audit.run` path with the company paused: 11 harness checks and the 10 audit-check outcomes. |

## Run

```bash
cd supabase/tests/local
npm install          # installs pg + the embedded Linux Postgres binaries
node run_all.mjs
```

`run_all.mjs` reuses a Postgres server at `NOVA_TEST_PG_URL` when one is
reachable. Otherwise it starts the embedded binaries against `.pgdata`, waits
for readiness and stops them when the run ends. It then drops and recreates
`nova_test` and `nova_audit_paused`; no other database is touched.

Requirements:

- Node 20 or newer.
- Deno 2 or newer for the end-to-end harness (`DENO_BIN` selects a binary that
  is not on `PATH`).
- On Linux, `npm install` provides the embedded Postgres. Elsewhere, point
  `NOVA_TEST_PG_URL` at a running server or `NOVA_TEST_PG_BIN` at a directory
  containing `initdb`, `postgres` and `pg_ctl`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `NOVA_TEST_PG_URL` | Server to use, e.g. `postgres://postgres@127.0.0.1:55432/postgres`. Default: that address. |
| `NOVA_TEST_PG_BIN` | Directory with local `initdb`/`postgres`/`pg_ctl` binaries. |
| `DENO_BIN` | Deno binary used for `audit_paused_e2e.ts`. |

The harnesses expect a superuser named `postgres` with trust authentication on
loopback, which is what `initdb` creates here. They never connect to Supabase
and never read provider keys, so no email, payment, search or model call is
made.

## What is not covered

The suites are database and handler verification only. They do not deploy to
Supabase, apply migrations to a hosted project, fire the scheduler cron, or use
a real search, email or Stripe credential. The audit's `provider_config` and
`live_key_guard` checks are therefore `blocked`, and the report is `blocked` by
design until those credentials exist.
