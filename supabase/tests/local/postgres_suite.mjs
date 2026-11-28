import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { urlForDatabase } from './postgres.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const DB = 'nova_test';

let client = new pg.Client({ connectionString: urlForDatabase('postgres') });

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectError(name, fn, needle) {
  try {
    await fn();
    check(name, false, 'no error was raised');
  } catch (error) {
    const message = `${error.message ?? error}`;
    check(name, message.toLowerCase().includes(needle.toLowerCase()), message);
  }
}

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

async function as(role, sub, sql, params = []) {
  await client.query('begin');
  try {
    await client.query(`set local role ${role}`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(sub ? { role, sub } : { role }),
    ]);
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

const asOwner = (id, sql, params) => as('authenticated', id, sql, params);
const asService = (sql, params) => as('service_role', null, sql, params);

function one(result) {
  return result.rows[0] ?? null;
}

/** A jsonb-returning function arrives as a single named column. */
function call(result) {
  const row = one(result);
  if (!row) return null;
  const values = Object.values(row);
  return values.length === 1 ? values[0] : row;
}

async function main() {
  await client.connect();
  await client.query(`drop database if exists ${DB}`);
  await client.query(`create database ${DB}`);
  await client.end();

  client = new pg.Client({ connectionString: urlForDatabase(DB) });
  await client.connect();

  await client.query(SHIM);

  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    try {
      await client.query(sql);
      console.log(`applied ${file}`);
    } catch (error) {
      console.error(`MIGRATION FAILED: ${file}\n${error.message}`);
      process.exit(1);
    }
  }

  const ownerA = '11111111-1111-4111-8111-111111111111';
  const ownerB = '22222222-2222-4222-8222-222222222222';

  await client.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [
    ownerA,
    'owner-a@example.com',
    ownerB,
    'owner-b@example.com',
  ]);

  const settings = one(
    await client.query('select payments_live, stripe_live_mode from business_settings where owner_id = $1', [ownerA]),
  );
  check('Stripe live mode is off by default', settings.stripe_live_mode === false);
  check('Payments are off by default', settings.payments_live === false);

  const lead = one(
    await client.query(
      `insert into public.leads (owner_id, business_name, domain, status, score)
       values ($1, 'Acme Dental', 'acme-dental.test', 'researched', 72) returning id`,
      [ownerA],
    ),
  );
  await client.query(
    `insert into public.contacts (owner_id, lead_id, name, email, email_normalized)
     values ($1, $2, 'Pat', 'pat@acme-dental.test', 'pat@acme-dental.test')`,
    [ownerA, lead.id],
  );

  const quote = one(
    await client.query(
      `insert into public.quotes (owner_id, lead_id, title, scope, amount_cents, status, delivery_days, expires_at)
       values ($1, $2, 'Website rebuild', 'Five pages and a contact form.', 50000, 'sent', 7, now() + interval '14 days')
       returning id`,
      [ownerA, lead.id],
    ),
  );

  const draftQuote = one(
    await client.query(
      `insert into public.quotes (owner_id, lead_id, title, scope, amount_cents, status, delivery_days, expires_at)
       values ($1, $2, 'Draft offer', 'Not released.', 20000, 'draft', 7, now() + interval '14 days')
       returning id`,
      [ownerA, lead.id],
    ),
  );

  check(
    'A checkout intent cannot be created by a signed-in user',
    await (async () => {
      try {
        await asOwner(ownerA, 'select public.create_checkout_intent($1)', [quote.id]);
        return false;
      } catch (error) {
        return `${error.message}`.includes('payments service only') || `${error.code}` === '42501';
      }
    })(),
  );

  await expectError(
    'A checkout is refused while payments are off',
    () => asService('select public.create_checkout_intent($1)', [quote.id]),
    'payments are not live',
  );

  await client.query('update business_settings set payments_live = true where owner_id = $1', [ownerA]);

  await expectError(
    'A checkout is refused for a draft quote',
    () => asService('select public.create_checkout_intent($1)', [draftQuote.id]),
    'has not accepted',
  );

  await asService('select public.accept_quote($1, $2, $3)', [quote.id, 'link', 'test harness']);

  const intent = one(await asService('select * from public.create_checkout_intent($1)', [quote.id]));
  check(
    'An accepted quote yields a Stripe payment record',
    intent.provider === 'stripe' && intent.amount_cents === 50000,
  );
  check('The record starts awaiting a checkout', intent.status === 'requires_payment');

  const reuse = one(await asService('select * from public.create_checkout_intent($1)', [quote.id]));
  check('A second checkout call reuses the same record', reuse.id === intent.id);

  await expectError(
    'A signed-in user cannot attach a checkout session',
    () =>
      asOwner(ownerA, 'select public.attach_checkout_session($1, $2, $3, $4)', [
        intent.id,
        'cs_test_owner_a',
        'https://checkout.stripe.com/c/pay/cs_test_owner_a',
        new Date(Date.now() + 3600_000).toISOString(),
      ]),
    'permission denied',
  );

  const attached = one(
    await asService('select * from public.attach_checkout_session($1, $2, $3, $4)', [
      intent.id,
      'cs_test_owner_a',
      'https://checkout.stripe.com/c/pay/cs_test_owner_a',
      new Date(Date.now() + 3600_000).toISOString(),
    ]),
  );
  check(
    'The checkout session is stored with https only',
    attached.status === 'checkout_created' && attached.checkout_url.startsWith('https://'),
  );

  await expectError(
    'A second open checkout session for the same payment is refused',
    () =>
      asService('select public.attach_checkout_session($1, $2, $3)', [
        intent.id,
        'cs_test_other',
        'https://checkout.stripe.com/c/pay/cs_test_other',
      ]),
    'already open',
  );

  await expectError(
    'A signed-in user cannot record a Stripe event',
    () => asOwner(ownerA, `select public.record_stripe_event('evt_denied', 'checkout.session.completed')`),
    'permission denied',
  );

  const mismatch = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_mismatch', p_type => 'checkout.session.completed',
        p_checkout_session_id => 'cs_test_owner_a', p_provider_ref => 'pi_test_1',
        p_amount_cents => 40000, p_currency => 'usd', p_outcome => 'paid'
      )`,
    ),
  );
  check(
    'An amount mismatch is refused and not applied',
    mismatch.matched === false && mismatch.reason === 'amount_mismatch',
  );
  check(
    'A mismatch leaves the payment awaiting confirmation',
    one(await client.query('select status from payment_intents where id = $1', [intent.id])).status ===
      'checkout_created',
  );
  check(
    'A mismatch creates no order',
    Number(one(await client.query('select count(*)::int as n from orders where owner_id = $1', [ownerA])).n) === 0,
  );

  const paid = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_paid_1', p_type => 'checkout.session.completed',
        p_checkout_session_id => 'cs_test_owner_a', p_provider_ref => 'pi_test_1',
        p_amount_cents => 50000, p_currency => 'usd', p_outcome => 'paid'
      )`,
    ),
  );
  check('A verified paid event creates the order', paid.paid === true && Boolean(paid.orderId));

  const paidIntent = one(await client.query('select * from payment_intents where id = $1', [intent.id]));
  check(
    'The payment is recorded as paid with a timestamp',
    paidIntent.status === 'succeeded' && paidIntent.paid_at !== null,
  );
  check('Stripe reference is stored', paidIntent.provider_ref === 'pi_test_1');

  const order = one(await client.query('select * from orders where owner_id = $1', [ownerA]));
  check('The order carries the verified amount and status', order.amount_cents === 50000 && order.status === 'paid');

  const duplicate = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_paid_1', p_type => 'checkout.session.completed',
        p_checkout_session_id => 'cs_test_owner_a', p_provider_ref => 'pi_test_1',
        p_amount_cents => 50000, p_currency => 'usd', p_outcome => 'paid'
      )`,
    ),
  );
  check('A duplicate event id is idempotent', duplicate.duplicate === true);

  const second = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_paid_2', p_type => 'checkout.session.completed',
        p_checkout_session_id => 'cs_test_owner_a', p_provider_ref => 'pi_test_1',
        p_amount_cents => 50000, p_currency => 'usd', p_outcome => 'paid'
      )`,
    ),
  );
  check('A second paid event does not duplicate the order', second.alreadyPaid === true);
  check(
    'Exactly one order exists',
    Number(one(await client.query('select count(*)::int as n from orders where owner_id = $1', [ownerA])).n) === 1,
  );

  const lateFailure = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_failed_late', p_type => 'payment_intent.payment_failed',
        p_intent_id => $1, p_amount_cents => 50000, p_outcome => 'failed'
      )`,
      [intent.id],
    ),
  );
  check('A late failure event does not downgrade a paid record', lateFailure.failed === true);
  check(
    'The paid record stays paid',
    one(await client.query('select status from payment_intents where id = $1', [intent.id])).status === 'succeeded',
  );

  const partial = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_refund_1', p_type => 'charge.refunded',
        p_provider_ref => 'pi_test_1', p_amount_cents => 50000, p_currency => 'usd',
        p_outcome => 'partially_refunded', p_refunded_cents => 20000
      )`,
    ),
  );
  check('A partial refund is recorded as partial', partial.refunded === true);
  const partialIntent = one(await client.query('select * from payment_intents where id = $1', [intent.id]));
  check(
    'Partial refund amount is stored',
    partialIntent.status === 'partially_refunded' && partialIntent.refunded_cents === 20000,
  );
  check(
    'The order follows the refund',
    one(await client.query('select status from orders where owner_id = $1', [ownerA])).status === 'partially_refunded',
  );

  const full = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_refund_2', p_type => 'charge.refunded',
        p_provider_ref => 'pi_test_1', p_amount_cents => 50000, p_currency => 'usd',
        p_outcome => 'refunded', p_refunded_cents => 50000
      )`,
    ),
  );
  check('A full refund is recorded', full.refunded === true);
  const refundedIntent = one(await client.query('select * from payment_intents where id = $1', [intent.id]));
  check(
    'The refunded total cannot exceed the charge',
    refundedIntent.refunded_cents === 50000 && refundedIntent.status === 'refunded',
  );
  check(
    'The order is marked refunded',
    one(await client.query('select status from orders where owner_id = $1', [ownerA])).status === 'refunded',
  );

  await expectError(
    'A refunded quote cannot open another checkout',
    () => asService('select public.create_checkout_intent($1)', [quote.id]),
    'already paid',
  );

  const unmatched = call(
    await asService(
      `select public.record_stripe_event(
        p_event_id => 'evt_unknown', p_type => 'checkout.session.completed',
        p_checkout_session_id => 'cs_test_unknown', p_amount_cents => 9999, p_outcome => 'paid'
      )`,
    ),
  );
  check('An unknown session is recorded but matches nothing', unmatched.matched === false);

  check(
    "Another owner cannot see this owner's orders",
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from orders')).n) === 0,
  );
  check(
    "Another owner cannot see this owner's payment records",
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from payment_intents')).n) === 0,
  );
  check(
    'The owner sees their own paid order',
    Number(one(await asOwner(ownerA, 'select count(*)::int as n from orders')).n) === 1,
  );

  check(
    'An owner records an expense',
    Boolean(
      one(
        await asOwner(
          ownerA,
          `insert into public.expenses (owner_id, category, note, amount_cents)
           values ($1, 'software', 'Design tool', 500) returning id`,
          [ownerA],
        ),
      ).id,
    ),
  );

  await expectError(
    'An owner cannot record an expense for another owner',
    () =>
      asOwner(
        ownerB,
        `insert into public.expenses (owner_id, category, note, amount_cents)
         values ($1, 'software', 'Not mine', 100)`,
        [ownerA],
      ),
    'row-level security',
  );

  const summary = one(await asOwner(ownerA, 'select public.finance_summary() as s')).s;
  check('Finance summary counts gross revenue', Number(summary.grossRevenueCents) === 50000);
  check('Finance summary nets out the refund', Number(summary.netRevenueCents) === 0);
  check('Finance summary reports the refund', Number(summary.refundedCents) === 50000);
  check('Finance summary counts expenses', Number(summary.expensesCents) === 500);
  check('Finance summary subtracts costs from profit', Number(summary.profitCents) === -500);
  check('Finance summary reports the order count', Number(summary.orderCount) === 1);
  check(
    'Finance summary reflects the live-mode switch',
    summary.stripeLiveMode === false && summary.paymentsLive === true,
  );

  const summaryB = one(await asOwner(ownerB, 'select public.finance_summary() as s')).s;
  check(
    'A different owner has an empty finance summary',
    Number(summaryB.grossRevenueCents) === 0 && Number(summaryB.expensesCents) === 0,
  );

  await expectError(
    'Delivery is blocked while the recorded payment is refunded',
    () => asOwner(ownerA, 'select public.open_delivery($1)', [quote.id]),
    'record the payment',
  );

  const quote2 = one(
    await client.query(
      `insert into public.quotes (owner_id, lead_id, title, scope, amount_cents, status, delivery_days, expires_at)
       values ($1, $2, 'Second site', 'Same scope.', 30000, 'sent', 5, now() + interval '10 days')
       returning id`,
      [ownerA, lead.id],
    ),
  );
  await asService('select public.accept_quote($1, $2, $3)', [quote2.id, 'link', 'test']);
  const intent2 = one(await asService('select * from public.create_checkout_intent($1)', [quote2.id]));
  await asService('select public.attach_checkout_session($1, $2, $3)', [
    intent2.id,
    'cs_test_owner_a_2',
    'https://checkout.stripe.com/c/pay/cs_test_owner_a_2',
  ]);
  await asService(
    `select public.record_stripe_event(
      p_event_id => 'evt_paid_3', p_type => 'checkout.session.completed',
      p_checkout_session_id => 'cs_test_owner_a_2', p_provider_ref => 'pi_test_3',
      p_amount_cents => 30000, p_currency => 'usd', p_outcome => 'paid'
    )`,
  );

  const delivery = one(await asOwner(ownerA, 'select * from public.open_delivery($1)', [quote2.id]));
  check(
    'A verified payment unlocks delivery',
    delivery.status === 'pending' && delivery.revisions_included >= 0,
  );

  check(
    'Stripe events are stored as evidence',
    Number(one(await client.query('select count(*)::int as n from stripe_events')).n) >= 6,
  );

  // Supabase's service_role bypasses RLS; the local shim needs the same attribute.
  await client.query('alter role service_role bypassrls');

  // ---------------------------------------------------------- Phase 3 follow-ups
  const sentMessage = one(
    await client.query(
      `insert into public.outreach_messages
         (owner_id, lead_id, to_email, to_name, subject, body, status, provider_message_id, sent_at)
       values ($1, $2, 'probe@example.com', 'Probe', 'A note', 'Hello there.', 'sent', 'pm_probe', now())
       returning id`,
      [ownerA, lead.id],
    ),
  );

  const followUp = one(
    await asOwner(ownerA, "select * from public.schedule_follow_up($1, now() + interval '3 days', $2)", [
      sentMessage.id,
      'Polite check-in.',
    ]),
  );
  check('An owner can schedule a follow-up on a sent message', followUp.status === 'scheduled');

  await expectError(
    'A second open follow-up for the same message is refused',
    () => asOwner(ownerA, "select public.schedule_follow_up($1, now() + interval '4 days')", [sentMessage.id]),
    'duplicate key',
  );

  await expectError(
    'Another owner cannot schedule a follow-up for that message',
    () => asOwner(ownerB, "select public.schedule_follow_up($1, now() + interval '3 days')", [sentMessage.id]),
    'unknown message',
  );

  check(
    'The owner can read the scheduled follow-up',
    Number(one(await asOwner(ownerA, 'select count(*)::int as n from follow_ups where message_id = $1', [sentMessage.id])).n) === 1,
  );
  check(
    'Another owner cannot read it',
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from follow_ups where message_id = $1', [sentMessage.id])).n) === 0,
  );

  await client.query("update public.outreach_messages set status = 'replied' where id = $1", [sentMessage.id]);
  check(
    'A reply cancels the open follow-up',
    one(await client.query('select status from follow_ups where message_id = $1', [sentMessage.id])).status === 'cancelled',
  );

  const sentOptOut = one(
    await client.query(
      `insert into public.outreach_messages
         (owner_id, lead_id, to_email, to_name, subject, body, status, provider_message_id, sent_at)
       values ($1, $2, 'optout@example.com', 'Probe', 'Another note', 'Hello again.', 'sent', 'pm_probe_2', now())
       returning id`,
      [ownerA, lead.id],
    ),
  );
  await asOwner(ownerA, "select public.schedule_follow_up($1, now() + interval '3 days')", [sentOptOut.id]);
  await client.query(
    "insert into public.suppression_list (owner_id, email_normalized, reason) values ($1, 'optout@example.com', 'unsubscribe')",
    [ownerA],
  );
  check(
    'Suppression cancels a scheduled follow-up',
    one(await client.query('select status from follow_ups where message_id = $1', [sentOptOut.id])).status === 'cancelled',
  );

  // ---------------------------------------------------------- Phase 4 quote terms
  const quoted = one(
    await client.query(
      `insert into public.quotes
         (owner_id, lead_id, title, scope, deliverables, terms, requirements, discount_cents, amount_cents)
       values ($1, $2, 'Terms quote', 'Full scope.', 'A report and a call.', '50% on acceptance.', array['logo'], 500, 19500)
       returning deliverables, terms, requirements, discount_cents`,
      [ownerA, lead.id],
    ),
  );
  check(
    'A quote stores deliverables, terms, requirements and discount',
    quoted.deliverables === 'A report and a call.' &&
      quoted.terms === '50% on acceptance.' &&
      quoted.requirements[0] === 'logo' &&
      Number(quoted.discount_cents) === 500,
  );

  // ---------------------------------------------------------- Phase 6 production
  const productionJob = one(
    await client.query('select * from public.production_jobs where quote_id = $1', [quote2.id]),
  );
  check(
    'A verified paid order creates a production job',
    Boolean(productionJob) && productionJob.status === 'queued',
  );

  check(
    'Production is off by default',
    one(await client.query('select production_enabled from public.business_settings where owner_id = $1', [ownerA]))
      .production_enabled === false,
  );

  await expectError(
    'start_production refuses while production is off',
    () => asOwner(ownerA, 'select public.start_production($1)', [productionJob.id]),
    'switched off',
  );

  await asOwner(ownerA, 'update public.business_settings set production_enabled = true where owner_id = $1', [
    ownerA,
  ]);

  const startedProduction = one(
    await asOwner(ownerA, 'select * from public.start_production($1)', [productionJob.id]),
  );
  check('start_production arms the job', startedProduction.status === 'generating');
  check(
    'start_production queues forge.produce',
    Number(
      one(
        await client.query(
          "select count(*)::int as n from public.agent_jobs where owner_id = $1 and kind = 'forge.produce'",
          [ownerA],
        ),
      ).n,
    ) >= 1,
  );

  await expectError(
    'A started production job cannot be started twice',
    () => asOwner(ownerA, 'select public.start_production($1)', [productionJob.id]),
    'already',
  );

  check(
    'Another owner sees no production jobs',
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from production_jobs')).n) === 0,
  );

  await expectError(
    'The app cannot insert a production file',
    () =>
      asOwner(
        ownerA,
        `insert into public.production_files
           (owner_id, job_id, version, name, storage_path, mime, bytes, sha256, kind)
         values ($1, $2, 1, 'fake.md', 'owner/job/v1/fake.md', 'text/markdown', 4, repeat('a', 64), 'primary')`,
        [ownerA, productionJob.id],
      ),
    'permission denied',
  );

  await asService(
    `insert into public.production_files
       (owner_id, job_id, version, name, storage_path, mime, bytes, sha256, kind)
     values ($1, $2, 1, 'audit.md', 'owner/job/v1/audit.md', 'text/markdown', 12, repeat('b', 64), 'primary')`,
    [ownerA, productionJob.id],
  );
  check(
    'The service role records a production file',
    Number(one(await client.query('select count(*)::int as n from production_files where job_id = $1', [productionJob.id])).n) === 1,
  );

  await asService(
    `insert into public.production_qa (owner_id, job_id, version, verdict, checks)
     values ($1, $2, 1, 'pass', '[]'::jsonb)`,
    [ownerA, productionJob.id],
  );
  check(
    'The service role records a QA verdict',
    Number(one(await client.query('select count(*)::int as n from production_qa where job_id = $1', [productionJob.id])).n) === 1,
  );

  check(
    'The owner can read their production files',
    Number(one(await asOwner(ownerA, 'select count(*)::int as n from production_files where job_id = $1', [productionJob.id])).n) === 1,
  );
  check(
    'Another owner cannot read them',
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from production_files where job_id = $1', [productionJob.id])).n) === 0,
  );

  // ---------------------------------------------------------- Phase 7 delivery
  await client.query(
    "update public.production_jobs set status = 'ready', version = 1, attempts = 1 where id = $1",
    [productionJob.id],
  );
  await asService(
    "update public.deliverables set status = 'delivered', delivered_at = now(), artifact_url = 'https://example.com/work' where id = $1",
    [delivery.id],
  );

  await expectError(
    'Only the worker can create a delivery link',
    () =>
      asOwner(ownerA, "select public.create_delivery_link($1, $2, now() + interval '7 days')", [
        delivery.id,
        'd'.repeat(64),
      ]),
    'permission denied',
  );

  const deliveryLink = one(
    await asService("select * from public.create_delivery_link($1, $2, now() + interval '7 days')", [
      delivery.id,
      'd'.repeat(64),
    ]),
  );
  check(
    'The worker creates a delivery link with a hashed token',
    Boolean(deliveryLink.id) && deliveryLink.token_hash === 'd'.repeat(64),
  );

  await expectError(
    'The app cannot resolve a delivery token',
    () => asOwner(ownerA, 'select * from public.resolve_delivery_token($1)', ['d'.repeat(64)]),
    'permission denied',
  );

  const resolved = one(
    await asService('select * from public.resolve_delivery_token($1)', ['d'.repeat(64)]),
  );
  check(
    'A valid token resolves to its deliverable and records the access',
    resolved?.deliverable_id === delivery.id &&
      Number(one(await client.query('select access_count from public.delivery_links where id = $1', [deliveryLink.id])).access_count) === 1,
  );

  await expectError(
    'Another owner cannot revoke the link',
    () => asOwner(ownerB, 'select public.revoke_delivery_link($1)', [deliveryLink.id]),
    'no active delivery link',
  );

  await asOwner(ownerA, 'select public.revoke_delivery_link($1)', [deliveryLink.id]);
  check(
    'A revoked token no longer resolves',
    one(await asService('select * from public.resolve_delivery_token($1)', ['d'.repeat(64)])) === null,
  );
  check(
    'Another owner cannot read the link',
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from public.delivery_links')).n) === 0,
  );
  check(
    'The owner can read their link',
    Number(one(await asOwner(ownerA, 'select count(*)::int as n from public.delivery_links')).n) === 1,
  );

  await asService(
    `insert into public.delivery_links (owner_id, deliverable_id, token_hash, expires_at)
     values ($1, $2, $3, now() - interval '1 day')`,
    [ownerA, delivery.id, 'e'.repeat(64)],
  );
  check(
    'An expired token does not resolve',
    one(await asService('select * from public.resolve_delivery_token($1)', ['e'.repeat(64)])) === null,
  );

  const revised = one(
    await asOwner(ownerA, 'select * from public.request_deliverable_revision($1, $2)', [
      delivery.id,
      'Please change the headline.',
    ]),
  );
  check(
    'A revision request marks the delivery and uses one revision',
    revised.status === 'revision_requested' && Number(revised.revisions_used) === 1,
  );

  const rearmed = one(await client.query('select * from public.production_jobs where id = $1', [productionJob.id]));
  check(
    'A revision re-arms production with a fresh attempt budget',
    rearmed.status === 'queued' && Number(rearmed.attempts) === 0 && rearmed.deliverable_id === delivery.id,
  );
  check(
    'A revision queues a new forge.produce run',
    Number(
      one(
        await client.query(
          "select count(*)::int as n from public.agent_jobs where owner_id = $1 and kind = 'forge.produce' and idempotency_key like '%:r1'",
          [ownerA],
        ),
      ).n,
    ) === 1,
  );

  await asService("update public.deliverables set status = 'delivered' where id = $1", [delivery.id]);
  await expectError(
    'The revision allowance is enforced',
    () => asOwner(ownerA, 'select public.request_deliverable_revision($1, $2)', [delivery.id, 'One more change.']),
    'no revision is left',
  );

  const history = one(await asOwner(ownerA, 'select * from public.customer_history() limit 1'));
  check(
    'Customer history shows the paid customer and their work',
    history?.lead_id === lead.id && Number(history.orders_count) >= 1 && Number(history.paid_cents) >= 30000,
  );
  check(
    'Another owner has no customer history',
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from public.customer_history()')).n) === 0,
  );

  await asService(
    `insert into public.outreach_messages
       (owner_id, lead_id, to_email, subject, body, status)
     values ($1, $2, 'delivery@example.com', 'Marketing note', 'Hello.', 'approved')`,
    [ownerA, lead.id],
  );
  const deliveryMessage = one(
    await asService(
      `insert into public.outreach_messages
         (owner_id, lead_id, to_email, subject, body, status, idempotency_key)
       values ($1, $2, 'delivery@example.com', 'Your work is ready', 'Download here.', 'approved', $3)
       returning id`,
      [ownerA, lead.id, `delivery:${delivery.id}`],
    ),
  );
  check(
    'A delivery message is not blocked by an open marketing draft',
    Boolean(deliveryMessage.id),
  );

  await expectError(
    'A second delivery message for the same deliverable is refused',
    () =>
      asService(
        `insert into public.outreach_messages
           (owner_id, lead_id, to_email, subject, body, status, idempotency_key)
         values ($1, $2, 'delivery@example.com', 'Duplicate', 'Again.', 'approved', $3)`,
        [ownerA, lead.id, `delivery:${delivery.id}`],
      ),
    'duplicate key',
  );

  await asService('update public.deliverables set delivery_message_id = $1 where id = $2', [
    deliveryMessage.id,
    delivery.id,
  ]);
  check(
    'A delivery records the email that carried it',
    one(await client.query('select delivery_message_id from public.deliverables where id = $1', [delivery.id]))
      .delivery_message_id === deliveryMessage.id,
  );


  // ---------------------------------------------------- Phase 7 completion
  await client.query(
    "update public.outreach_messages set status = 'sent', sent_at = now(), provider_message_id = 'pm_delivery' where id = $1",
    [deliveryMessage.id],
  );
  await client.query("update public.leads set status = 'qualified' where id = $1", [lead.id]);

  const plan = one(
    await asOwner(ownerA, 'select public.schedule_delivery_follow_ups($1) as plan', [deliveryMessage.id]),
  ).plan;
  check(
    'A delivery schedules receipt, review and recurring follow-ups',
    Array.isArray(plan.scheduled) &&
      plan.scheduled.length === 3 &&
      ['receipt', 'review', 'recurring'].every((kind) => plan.scheduled.includes(kind)),
  );
  check(
    'The three follow-ups are stored with distinct kinds',
    Number(
      one(
        await client.query(
          "select count(distinct kind)::int as n from follow_ups where message_id = $1 and kind in ('receipt','review','recurring')",
          [deliveryMessage.id],
        ),
      ).n,
    ) === 3,
  );

  const replanned = one(
    await asOwner(ownerA, 'select public.schedule_delivery_follow_ups($1) as plan', [deliveryMessage.id]),
  ).plan;
  check('Scheduling the same retention plan again adds nothing', replanned.scheduled.length === 0);

  await expectError(
    'Another owner cannot schedule retention for that delivery',
    () => asOwner(ownerB, 'select public.schedule_delivery_follow_ups($1)', [deliveryMessage.id]),
    'unknown message',
  );

  await client.query(
    "insert into public.suppression_list (owner_id, email_normalized, reason) values ($1, 'delivery@example.com', 'unsubscribe')",
    [ownerA],
  );
  check(
    'A suppression cancels every kind of retention follow-up',
    Number(
      one(
        await client.query(
          "select count(*)::int as n from follow_ups where message_id = $1 and status = 'cancelled' and kind in ('receipt','review','recurring')",
          [deliveryMessage.id],
        ),
      ).n,
    ) === 3,
  );
  await client.query(
    "delete from public.suppression_list where owner_id = $1 and email_normalized = 'delivery@example.com'",
    [ownerA],
  );
  const replannedAfter = one(
    await asOwner(ownerA, 'select public.schedule_delivery_follow_ups($1) as plan', [deliveryMessage.id]),
  ).plan;
  check(
    'The retention plan can be scheduled again after the block is lifted',
    replannedAfter.scheduled.length === 3,
  );

  await client.query(
    "update public.deliverables set revisions_included = 3, revisions_used = 1, status = 'delivered', delivered_at = now(), artifact_url = 'https://example.com/work', revision_note = null where id = $1",
    [delivery.id],
  );
  await asService(
    `insert into public.delivery_links (owner_id, deliverable_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '7 days')`,
    [ownerA, delivery.id, 'f'.repeat(64)],
  );

  await expectError(
    'A customer revision cannot be requested with a signed-in app session',
    () =>
      asOwner(ownerA, 'select public.request_delivery_revision($1, $2)', [
        'f'.repeat(64),
        'Change the headline.',
      ]),
    'permission denied',
  );

  const publicRevision = one(
    await asService('select public.request_delivery_revision($1, $2) as r', [
      'f'.repeat(64),
      'Change the headline.',
    ]),
  ).r;
  check(
    'A customer can request a revision from the delivery link',
    publicRevision.ok === true && Number(publicRevision.revisionsRemaining) === 1,
  );

  const afterPublicRevision = one(
    await client.query('select status, revisions_used, revision_note from deliverables where id = $1', [delivery.id]),
  );
  check(
    'The customer revision marks the delivery and stores their note',
    afterPublicRevision.status === 'revision_requested' &&
      Number(afterPublicRevision.revisions_used) === 2 &&
      afterPublicRevision.revision_note === 'Change the headline.',
  );

  await expectError(
    'The same delivery cannot take a second revision while one is open',
    () =>
      asService('select public.request_delivery_revision($1, $2)', [
        'f'.repeat(64),
        'And the colours.',
      ]),
    'not waiting for a revision',
  );

  await asService(
    `insert into public.delivery_links (owner_id, deliverable_id, token_hash, expires_at)
     values ($1, $2, $3, now() - interval '1 hour')`,
    [ownerA, delivery.id, '9'.repeat(64)],
  );
  await expectError(
    'An expired link cannot request a revision',
    () =>
      asService('select public.request_delivery_revision($1, $2)', [
        '9'.repeat(64),
        'Change the footer.',
      ]),
    'no longer available',
  );

  await asService(
    `insert into public.delivery_links (owner_id, deliverable_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '2 days'), ($1, $2, $4, now() + interval '3 days')`,
    [ownerA, delivery.id, '1'.repeat(64), '2'.repeat(64)],
  );
  await expectError(
    'Another owner cannot revoke a delivery link',
    () => asOwner(ownerB, 'select public.revoke_delivery_links($1)', [delivery.id]),
    'unknown delivery',
  );
  const revokedCount = Number(
    one(await asOwner(ownerA, 'select public.revoke_delivery_links($1) as n', [delivery.id])).n,
  );
  check('The owner can revoke every live link for a delivery', revokedCount >= 3);
  check(
    'No live delivery link remains after revocation',
    Number(
      one(
        await client.query(
          'select count(*)::int as n from delivery_links where deliverable_id = $1 and revoked_at is null',
          [delivery.id],
        ),
      ).n,
    ) === 0,
  );

  await client.query('delete from public.follow_ups where message_id = $1', [deliveryMessage.id]);
  await client.query(
    "insert into public.suppression_list (owner_id, email_normalized, reason) values ($1, 'delivery@example.com', 'unsubscribe')",
    [ownerA],
  );
  const optedOutPlan = one(
    await asOwner(ownerA, 'select public.schedule_delivery_follow_ups($1) as plan', [deliveryMessage.id]),
  ).plan;
  check(
    'An opted-out delivery records a skipped plan instead of retrying every cycle',
    optedOutPlan.skipped === 'opt_out' && optedOutPlan.scheduled.length === 0,
  );
  check(
    'The skipped plan is stored as three non-open follow-ups',
    Number(
      one(
        await client.query(
          "select count(*)::int as n from follow_ups where message_id = $1 and status = 'skipped' and kind in ('receipt','review','recurring')",
          [deliveryMessage.id],
        ),
      ).n,
    ) === 3,
  );
  await client.query(
    "delete from public.suppression_list where owner_id = $1 and email_normalized = 'delivery@example.com'",
    [ownerA],
  );

  // ---------------------------------------------------- Phase 8 company loop
  const snapshot = one(await asOwner(ownerA, 'select public.nova_loop_snapshot() as s')).s;
  check(
    'The loop snapshot exposes the mode and owner counts',
    snapshot.mode === 'paused' && typeof snapshot.counts.leadsTotal === 'number',
  );
  check(
    'The loop snapshot reports the AI budget honestly',
    Number(snapshot.aiBudgetCents) >= 0 && Number(snapshot.aiRemainingCents) >= 0,
  );

  const workerSnapshot = one(
    await asService('select public.nova_loop_snapshot($1) as s', [ownerA]),
  ).s;
  check(
    'The worker can read the snapshot for its owner',
    workerSnapshot.mode === 'paused' && Number(workerSnapshot.counts.leadsTotal) >= 1,
  );

  await expectError(
    'An owner cannot read another owner company snapshot',
    () => asOwner(ownerB, 'select public.nova_loop_snapshot($1)', [ownerA]),
    'not allowed',
  );

  const emptySnapshot = one(await asOwner(ownerB, 'select public.nova_loop_snapshot() as s')).s;
  check(
    'Another owner sees an empty company',
    Number(emptySnapshot.counts.leadsTotal) === 0 && Number(emptySnapshot.counts.ordersPaid) === 0,
  );

  check(
    'An empty company has not spent its discovery day',
    Number(emptySnapshot.counts.discoveryToday) === 0,
  );
  await asService(
    "select public.enqueue_agent_job('atlas.discover', '{\"source\":\"test\"}'::jsonb, 'test:discovery:today', now(), 100, $1)",
    [ownerB],
  );
  const afterDiscovery = one(await asOwner(ownerB, 'select public.nova_loop_snapshot() as s')).s;
  check(
    'The snapshot marks discovery as spent so the scheduler cannot queue it again today',
    Number(afterDiscovery.counts.discoveryToday) === 1,
  );

  await expectError(
    'A signed-in owner cannot write a company cycle',
    () =>
      asOwner(ownerA, "select public.record_company_cycle($1, 'manual:1', 'idle', 'idle')", [ownerA]),
    'permission denied',
  );

  const cycle = one(
    await asService(
      "select * from public.record_company_cycle($1, 'test:1', 'action', 'discover_leads', '{\"reason\":\"test\"}'::jsonb)",
      [ownerA],
    ),
  );
  check(
    'The worker records a company cycle',
    cycle.cycle_key === 'test:1' && cycle.decision === 'discover_leads' && cycle.status === 'action',
  );

  const cycleAgain = one(
    await asService(
      "select * from public.record_company_cycle($1, 'test:1', 'idle', 'something_else')",
      [ownerA],
    ),
  );
  check('A repeated cycle key does not write a second row', cycleAgain.id === cycle.id);
  check(
    'A company cycle is visible to its owner',
    Number(one(await asOwner(ownerA, 'select count(*)::int as n from company_cycles')).n) >= 1,
  );
  check(
    'Another owner cannot see the cycle',
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from company_cycles')).n) === 0,
  );

  await client.query(
    'update business_settings set ai_budget_cents = 100, ai_spend_cents = 0 where owner_id = $1',
    [ownerA],
  );
  const spent = one(
    await asService("select * from public.record_ai_spend($1, 60, 'test call')", [ownerA]),
  );
  check('AI spend is recorded against the budget', Number(spent.ai_spend_cents) === 60);
  await expectError(
    'AI spend past the cap is refused',
    () => asService("select public.record_ai_spend($1, 50, 'over budget')", [ownerA]),
    'cap would be exceeded',
  );
  await client.query(
    'update business_settings set ai_budget_cents = 0, ai_spend_cents = 0 where owner_id = $1',
    [ownerA],
  );

  // ---------------------------------------------------- Phase 9 recovery
  const stale = one(
    await client.query(
      `insert into public.agent_jobs
         (owner_id, kind, status, attempts, max_attempts, locked_by, locked_at, locked_until, idempotency_key)
       values ($1, 'system.ping', 'running', 1, 3, 'dead-worker', now() - interval '10 minutes',
               now() - interval '5 minutes', 'phase9:stale')
       returning id`,
      [ownerA],
    ),
  );
  const expired = one(
    await client.query(
      `insert into public.agent_jobs
         (owner_id, kind, status, attempts, max_attempts, locked_by, locked_at, locked_until, idempotency_key)
       values ($1, 'system.ping', 'running', 3, 3, 'dead-worker', now() - interval '10 minutes',
               now() - interval '5 minutes', 'phase9:expired')
       returning id`,
      [ownerA],
    ),
  );
  const recovered = one(
    await asService('select public.requeue_stale_jobs() as n'),
  );
  const staleAfter = one(
    await client.query('select status from public.agent_jobs where id = $1', [stale.id]),
  );
  const expiredAfter = one(
    await client.query('select status from public.agent_jobs where id = $1', [expired.id]),
  );
  check(
    'An interrupted job is requeued and an exhausted one is marked dead',
    Number(recovered.n) >= 2 && staleAfter.status === 'queued' && expiredAfter.status === 'dead',
  );

  // ---------------------------------------------------- Phase 9 audit and dry-run
  const dbAudit = one(
    await asService('select public.audit_database($1) as a', [ownerA]),
  ).a;

  check(
    'Every public table has RLS and no anon table grant',
    dbAudit.tablesWithoutRls.length === 0 && dbAudit.anonTableGrants.length === 0,
  );
  check(
    'Every SECURITY DEFINER function pins search_path',
    dbAudit.definerWithoutSearchPath.length === 0,
  );
  check(
    'No SECURITY DEFINER function is directly executable by anon',
    dbAudit.anonExecutableDefiners.length === 0,
    JSON.stringify(dbAudit.anonExecutableDefiners),
  );
  check(
    'The end-to-end fixtures pass payment and delivery integrity',
    Number(dbAudit.ordersWithoutConfirmedPayment) === 0 &&
      Number(dbAudit.ordersWithAmountMismatch) === 0 &&
      Number(dbAudit.deliveredWithoutAcceptedQuote) === 0 &&
      Number(dbAudit.deliveredWithoutMessage) === 0 &&
      Number(dbAudit.productionWithoutPaidOrder) === 0,
  );

  const audit1 = one(await asOwner(ownerA, 'select * from public.start_audit_run(true)'));
  check(
    'A dry-run audit is queued with a worker job',
    audit1.status === 'queued' && audit1.dry_run === true && Boolean(audit1.job_id),
  );
  await expectError(
    'A second audit cannot pile up while one is queued',
    () => asOwner(ownerA, 'select public.start_audit_run(true)'),
    'already queued or running',
  );
  await expectError(
    'A live audit cannot be started',
    () => asOwner(ownerA, 'select public.start_audit_run(false)'),
    'dry-run only',
  );
  check(
    'Another owner cannot see the audit run',
    Number(one(await asOwner(ownerB, 'select count(*)::int as n from audit_runs')).n) === 0,
  );
  await expectError(
    'A signed-in owner cannot write audit checks',
    () =>
      asOwner(ownerA, "select public.record_audit_check($1, 'x', 'pass', 'x')", [audit1.id]),
    'permission denied',
  );
  await expectError(
    'A signed-in owner cannot finish an audit run',
    () => asOwner(ownerA, 'select public.finish_audit_run($1)', [audit1.id]),
    'permission denied',
  );

  await asService(
    "select public.record_audit_check($1, 'database_security', 'pass', 'ok')",
    [audit1.id],
  );
  await asService(
    "select public.record_audit_check($1, 'provider_config', 'blocked', 'missing provider')",
    [audit1.id],
  );
  const blockedAudit = one(
    await asService('select * from public.finish_audit_run($1)', [audit1.id]),
  );
  check(
    'A blocked check makes the audit blocked, never passed',
    blockedAudit.status === 'blocked' &&
      Number(blockedAudit.summary.blocked) === 1 &&
      blockedAudit.checks.length === 2,
  );

  const audit2 = one(await asOwner(ownerA, 'select * from public.start_audit_run(true)'));
  await asService(
    "select public.record_audit_check($1, 'payment_integrity', 'fail', 'test failure')",
    [audit2.id],
  );
  await asService(
    "select public.record_audit_check($1, 'database_security', 'pass', 'ok')",
    [audit2.id],
  );
  const failedAudit = one(
    await asService('select * from public.finish_audit_run($1)', [audit2.id]),
  );
  check(
    'One failed check makes the audit failed',
    failedAudit.status === 'failed' && Number(failedAudit.summary.failed) === 1,
  );

  const audit3 = one(await asOwner(ownerA, 'select * from public.start_audit_run(true)'));
  await asService(
    "select public.record_audit_check($1, 'database_security', 'pass', 'ok')",
    [audit3.id],
  );
  await asService(
    "select public.record_audit_check($1, 'payment_integrity', 'pass', 'ok')",
    [audit3.id],
  );
  const passedAudit = one(
    await asService('select * from public.finish_audit_run($1)', [audit3.id]),
  );
  check(
    'Only an audit with no fail or blocked check passes',
    passedAudit.status === 'passed' && Number(passedAudit.summary.passed) === 2,
  );
  check(
    'The audit report is visible to its owner after completion',
    Number(one(await asOwner(ownerA, 'select count(*)::int as n from audit_runs')).n) === 3,
  );

  const audit4 = one(await asOwner(ownerA, 'select * from public.start_audit_run(true)'));
  await client.query("update public.agent_jobs set status = 'dead' where id = $1", [audit4.job_id]);
  const audit5 = one(await asOwner(ownerA, 'select * from public.start_audit_run(true)'));
  const abandoned = one(
    await asOwner(ownerA, 'select status from public.audit_runs where id = $1', [audit4.id]),
  );
  check(
    'A dead audit job is closed and does not block the next audit',
    audit5.status === 'queued' && abandoned.status === 'failed',
  );

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(` - ${failure}`);
    process.exitCode = 1;
  }

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
