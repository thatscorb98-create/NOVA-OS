/**
 * Throwaway end-to-end harness for the paused-audit fix.
 *
 * Creates a fresh database, applies every migration, starts an audit as the
 * signed-in owner with the company paused, then runs the real runQueue and the
 * real audit.run handler through a small service-role adapter over Postgres.
 */
import pg from 'npm:pg@8';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const DB = 'nova_audit_paused';

const BASE_URL =
  process.env.NOVA_TEST_PG_URL?.trim() || 'postgres://postgres@127.0.0.1:55432/postgres';

function dbUrl(name) {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}
const OWNER = '11111111-1111-4111-8111-111111111111';

const { runQueue } = await import(`file://${ROOT}/supabase/functions/_shared/worker.ts`);

const SHIM = `
do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid;
$$;
create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user
  );
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
`;

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '  ok  ' : 'FAIL  '}${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- database
let bootstrap = new pg.Client({ connectionString: dbUrl('postgres') });
await bootstrap.connect();
await bootstrap.query(`drop database if exists ${DB}`);
await bootstrap.query(`create database ${DB}`);
await bootstrap.end();

const db = new pg.Client({ connectionString: dbUrl(DB) });
await db.connect();
await db.query(SHIM);

for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
  try {
    await db.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
    console.log(`applied ${file}`);
  } catch (error) {
    console.error(`MIGRATION FAILED: ${file}\n${error.message}`);
    process.exit(1);
  }
}

await db.query('insert into auth.users (id, email) values ($1, $2)', [OWNER, 'owner@example.com']);
await db.query("update public.business_settings set autonomy_mode = 'paused' where owner_id = $1", [OWNER]);

// The owner starts the audit through the real authenticated RPC.
const ownerDb = new pg.Client({ connectionString: dbUrl(DB) });
await ownerDb.connect();
await ownerDb.query('set role authenticated');
await ownerDb.query(`select set_config('request.jwt.claims', $1, false)`, [
  JSON.stringify({ role: 'authenticated', sub: OWNER }),
]);
const auditRun = (await ownerDb.query('select * from public.start_audit_run(true)')).rows[0];
await ownerDb.end();
check('The owner started a dry-run audit', Boolean(auditRun?.id) && auditRun.dry_run === true);

// ---------------------------------------------------------------- adapter
const query = async (sql, params = []) => {
  try {
    const result = await db.query(sql, params);
    return { rows: result.rows, error: null };
  } catch (error) {
    return { rows: [], error: { message: error.message } };
  }
};

const RPC = {
  heartbeat_worker: {
    sql: 'select public.heartbeat_worker($1,$2,$3,$4)',
    args: ['p_worker_id', 'p_status', 'p_version', 'p_owner_id'],
  },
  claim_agent_jobs: {
    sql: 'select * from public.claim_agent_jobs($1,$2,$3)',
    args: ['p_worker_id', 'p_limit', 'p_owner_id'],
    rows: true,
  },
  release_agent_job: {
    sql: 'select public.release_agent_job($1,$2::interval,$3)',
    args: ['p_job_id', 'p_delay', 'p_reason'],
  },
  complete_agent_job: {
    sql: 'select public.complete_agent_job($1,$2::jsonb)',
    args: ['p_job_id', 'p_result'],
    json: ['p_result'],
  },
  fail_agent_job: {
    sql: 'select public.fail_agent_job($1,$2)',
    args: ['p_job_id', 'p_error'],
  },
  record_audit_check: {
    sql: 'select * from public.record_audit_check($1,$2,$3,$4,$5::jsonb)',
    args: ['p_run_id', 'p_key', 'p_status', 'p_detail', 'p_data'],
    rows: true,
    json: ['p_data'],
  },
  finish_audit_run: {
    sql: 'select * from public.finish_audit_run($1,$2::jsonb)',
    args: ['p_run_id', 'p_summary'],
    rows: true,
    json: ['p_summary'],
  },
  audit_database: {
    sql: 'select public.audit_database($1) as data',
    args: ['p_owner_id'],
    single: 'data',
  },
};

const admin = {
  async rpc(name, payload = {}) {
    const spec = RPC[name];
    if (!spec) return { data: null, error: { message: `adapter: unmapped rpc ${name}` } };

    const values = spec.args.map((key) =>
      spec.json?.includes(key) ? JSON.stringify(payload[key] ?? {}) : payload[key] ?? null,
    );
    const result = await query(spec.sql, values);
    if (result.error) return { data: null, error: result.error };

    if (spec.single) return { data: result.rows[0]?.[spec.single] ?? null, error: null };
    if (spec.rows) return { data: result.rows, error: null };
    return { data: result.rows[0] ?? null, error: null };
  },

  from(table) {
    return {
      select(columns) {
        const filters = [];
        const builder = {
          eq(column, value) {
            filters.push([column, value]);
            return builder;
          },
          async maybeSingle() {
            const where = filters.map(([column], index) => `${column} = $${index + 1}`).join(' and ');
            const result = await query(
              `select ${columns} from public.${table}${where ? ` where ${where}` : ''} limit 1`,
              filters.map(([, value]) => value),
            );
            if (result.error) return { data: null, error: result.error };
            return { data: result.rows[0] ?? null, error: null };
          },
        };
        return builder;
      },
      async insert(row) {
        const keys = Object.keys(row);
        const values = keys.map((key) => {
          const value = row[key];
          return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
        });
        const result = await query(
          `insert into public.${table} (${keys.join(',')}) values (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
          values,
        );
        return { data: null, error: result.error };
      },
    };
  },
};

// Service-role claims; the superuser connection bypasses RLS for the adapter.
await db.query(`select set_config('request.jwt.claims', $1, false)`, [
  JSON.stringify({ role: 'service_role' }),
]);

const summary = await runQueue({ admin, workerId: 'e2e-paused', limit: 1, ownerId: OWNER });
console.log('runQueue', JSON.stringify(summary));

// ---------------------------------------------------------------- report
const run = (
  await db.query('select status, checks, summary, dry_run from public.audit_runs where id = $1', [
    auditRun.id,
  ])
).rows[0];
const job = (
  await db.query('select status, attempts, payload, last_error from public.agent_jobs where id = $1', [
    auditRun.job_id,
  ])
).rows[0];

check('The worker claimed and succeeded the audit job', job.status === 'succeeded', job.last_error ?? '');
check('The audit report finished', run.status === 'blocked', run.status);
check('The report stayed dry-run only', run.dry_run === true);

const checks = run.checks ?? [];
const byKey = Object.fromEntries(checks.map((entry) => [entry.key, entry]));
console.log('checks', JSON.stringify(checks.map((entry) => ({ key: entry.key, status: entry.status }))));

check('Every check was recorded', checks.length === 10, `${checks.length} checks`);
check('No check failed', checks.every((entry) => entry.status !== 'fail'));

const guard = byKey.live_key_guard;
check(
  'live_key_guard is blocked without a Stripe key',
  guard?.status === 'blocked',
  guard?.detail ?? 'missing check',
);
check(
  'live_key_guard did not claim a live key was present',
  guard?.data?.liveStripeKey === false,
  JSON.stringify(guard?.data ?? {}),
);

check(
  'provider_config is blocked on missing providers',
  byKey.provider_config?.status === 'blocked',
  byKey.provider_config?.detail ?? 'missing check',
);
check(
  'The overall report counts the blocked checks',
  Number(run.summary?.blocked) === 2,
  JSON.stringify(run.summary ?? {}),
);

const forbidden = ['SEARCH_PROVIDER', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'AGENTMAIL_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
check(
  'No provider key was configured for this run',
  forbidden.every((key) => !Deno.env.get(key)),
);

await db.end();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
