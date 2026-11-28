/**
 * Stripe webhook signature test.
 *
 * Run from the repository root:
 *
 *   deno test supabase/tests/stripe_signature_test.ts
 *
 * No network and no Stripe key are needed: the test signs the same
 * `${timestamp}.${body}` string Stripe signs.
 */

import {
  signStripePayload,
  verifyStripeSignature,
} from '../functions/_shared/stripe-signature.ts';

const SECRET = 'whsec_phase9_test_secret';
const BODY = JSON.stringify({
  id: 'evt_phase9',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_phase9', payment_status: 'paid' } },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

Deno.test('a correctly signed Stripe payload is accepted', async () => {
  const timestamp = String(nowSeconds());
  const signature = await signStripePayload(BODY, timestamp, SECRET);

  const result = await verifyStripeSignature(BODY, `t=${timestamp},v1=${signature}`, SECRET);
  assert(result.ok, `expected a valid signature, got ${result.reason}`);
});

Deno.test('a signature made with another secret is rejected', async () => {
  const timestamp = String(nowSeconds());
  const signature = await signStripePayload(BODY, timestamp, 'whsec_wrong_secret');

  const result = await verifyStripeSignature(BODY, `t=${timestamp},v1=${signature}`, SECRET);
  assert(!result.ok && result.reason === 'signature mismatch', 'a forged signature was accepted');
});

Deno.test('a tampered body is rejected even with the original signature', async () => {
  const timestamp = String(nowSeconds());
  const signature = await signStripePayload(BODY, timestamp, SECRET);

  const result = await verifyStripeSignature(
    BODY.replace('paid', 'unpaid'),
    `t=${timestamp},v1=${signature}`,
    SECRET,
  );
  assert(!result.ok && result.reason === 'signature mismatch', 'a tampered body was accepted');
});

Deno.test('a stale timestamp is rejected', async () => {
  const timestamp = String(nowSeconds() - 301);
  const signature = await signStripePayload(BODY, timestamp, SECRET);

  const result = await verifyStripeSignature(BODY, `t=${timestamp},v1=${signature}`, SECRET);
  assert(!result.ok && result.reason === 'timestamp outside tolerance', 'a stale event was accepted');
});

Deno.test('a missing timestamp or signature is rejected', async () => {
  const missing = await verifyStripeSignature(BODY, 'v1=abc', SECRET);
  assert(!missing.ok && missing.reason === 'missing timestamp or signature', 'an empty header was accepted');
});

Deno.test('multiple v1 signatures are checked and one valid value is enough', async () => {
  const timestamp = String(nowSeconds());
  const valid = await signStripePayload(BODY, timestamp, SECRET);

  const result = await verifyStripeSignature(
    BODY,
    `t=${timestamp},v1=${'0'.repeat(64)},v1=${valid}`,
    SECRET,
  );
  assert(result.ok, `a valid signature among several was rejected: ${result.reason}`);
});
