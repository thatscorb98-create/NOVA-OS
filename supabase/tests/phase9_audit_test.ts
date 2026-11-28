/**
 * Phase 9 audit regression checks.
 *
 * Run from the repository root:
 *
 *   deno test supabase/tests/phase9_audit_test.ts
 *
 * Two defects found by the first end-to-end audit run are pinned here:
 *
 *   1. a paused company deferred the audit it had been asked to run;
 *   2. a missing Stripe key was reported as `live_key_guard: pass`.
 */

import { liveKeyGuardCheck } from '../functions/_shared/audit-checks.ts';
import { isSystemJob, runsWhilePaused } from '../functions/_shared/pause-policy.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ownerStartedAudit = { auditRunId: '00000000-0000-0000-0000-000000000001', ownerStarted: true };

Deno.test('a paused company runs an owner-started dry-run audit', () => {
  assert(
    runsWhilePaused('audit.run', ownerStartedAudit),
    'the owner-started audit was deferred while the company was paused',
  );
});

Deno.test('the pause exemption covers system jobs only besides the owner audit', () => {
  assert(isSystemJob('system.health_sweep'), 'a system job was not treated as system work');
  assert(
    runsWhilePaused('system.health_sweep', {}),
    'a system job was deferred while the company was paused',
  );

  assert(
    !runsWhilePaused('audit.run', { auditRunId: ownerStartedAudit.auditRunId }),
    'an audit without the owner-started marker bypassed the pause',
  );
  assert(
    !runsWhilePaused('audit.run', { ownerStarted: 'yes' }),
    'a non-boolean owner-started marker bypassed the pause',
  );
  assert(
    !runsWhilePaused('relay.send_email', { ownerStarted: true }),
    'a live send inherited the audit pause exemption',
  );
  assert(
    !runsWhilePaused('nova.orchestrate', { manual: true }),
    'a manual company cycle bypassed the pause',
  );
});

Deno.test('live_key_guard is blocked when no Stripe key is configured', () => {
  const result = liveKeyGuardCheck(null);

  assert(result.status === 'blocked', `a missing key was reported as ${result.status}`);
  assert(
    result.detail.includes('could not be exercised'),
    'the blocked detail does not say the guard was untested',
  );
  assert(result.data.liveStripeKey === false, 'the blocked result claims a live key is present');
});

Deno.test('live_key_guard still refuses a live key and passes a test key', () => {
  const live = liveKeyGuardCheck('sk_live_example');
  assert(live.status === 'fail', `a live key was reported as ${live.status}`);
  assert(live.data.liveStripeKey === true, 'a live key was not recorded as live');

  const test = liveKeyGuardCheck('sk_test_example');
  assert(test.status === 'pass', `a test key was reported as ${test.status}`);
  assert(test.data.liveStripeKey === false, 'a test key was recorded as live');
});
