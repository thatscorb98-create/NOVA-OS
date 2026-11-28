/**
 * Phase 9 audit check decisions that do not need a database or a provider.
 *
 * A check that cannot actually run must never be reported as a pass. The
 * live-key guard is the clearest case: with no Stripe key there is nothing to
 * classify, so the guard is `blocked`, not `pass`.
 */

export type AuditCheckStatus = 'pass' | 'fail' | 'blocked';

export interface AuditCheckResult {
  status: AuditCheckStatus;
  detail: string;
  data: Record<string, unknown>;
}

/**
 * Decide whether the configured Stripe key may be used for a controlled test.
 *
 * - live key present: `fail` — Phase 9 must use a test key.
 * - test key present: `pass` — the guard ran and refused nothing.
 * - no key: `blocked` — the rejection branch was not exercised.
 */
export function liveKeyGuardCheck(stripeKey: string | null | undefined): AuditCheckResult {
  if (stripeKey?.startsWith('sk_live_')) {
    return {
      status: 'fail',
      detail: 'A live Stripe key is present. Phase 9 must use a test key until the dry run passes.',
      data: { liveStripeKey: true },
    };
  }

  if (stripeKey) {
    return {
      status: 'pass',
      detail: 'The Stripe key is a test key, so no live key was present to refuse.',
      data: { liveStripeKey: false },
    };
  }

  return {
    status: 'blocked',
    detail:
      'No Stripe key is configured, so the live-key guard could not be exercised. No Stripe call was attempted.',
    data: { liveStripeKey: false },
  };
}
