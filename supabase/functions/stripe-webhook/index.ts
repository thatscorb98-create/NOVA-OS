import { fail, json, methodNotAllowed, preflight } from '../_shared/http.ts';
import { adminClient, env, SERVICE_VERSION } from '../_shared/supabase.ts';
import { verifyStripeSignature } from '../_shared/stripe-signature.ts';

/**
 * Stripe webhook.
 *
 * The only path that can mark a payment paid. Every request is verified against
 * `STRIPE_WEBHOOK_SECRET` before the body is trusted: HMAC-SHA256 over
 * `${timestamp}.${raw body}`, compared in constant time, within five minutes.
 *
 * A forged signature is rejected with 400 and writes nothing. A valid event is
 * handed to `record_stripe_event`, which deduplicates by Stripe event id,
 * matches our own payment record, checks the amount and currency, and creates
 * the order exactly once.
 *
 * No user session is involved: Stripe calls this endpoint directly.
 */

interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

interface RecordArgs {
  p_event_id: string;
  p_type: string;
  p_checkout_session_id: string | null;
  p_provider_ref: string | null;
  p_amount_cents: number | null;
  p_currency: string | null;
  p_outcome: string | null;
  p_refunded_cents: number | null;
  p_payload: Record<string, unknown>;
  p_intent_id: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  if (req.method !== 'POST') return methodNotAllowed();

  const secret = env('STRIPE_WEBHOOK_SECRET');
  if (!secret) {
    // Do not pretend the event was handled: Stripe should retry once the owner
    // has finished configuring the endpoint.
    return fail(
      'STRIPE_WEBHOOK_SECRET is not set for this project, so no event can be verified.',
      503,
    );
  }

  const signature = req.headers.get('stripe-signature') ?? '';
  if (!signature) return fail('A Stripe-Signature header is required.', 401);

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return fail('A request body is required.');
  }

  const verified = await verifyStripeSignature(raw, signature, secret);
  if (!verified.ok) {
    return fail(`Invalid Stripe signature: ${verified.reason}. Nothing was recorded.`, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return fail('The verified body was not JSON.', 400);
  }

  const eventId = text(event.id);
  const type = text(event.type);
  if (!eventId || !type) return fail('The event needs an id and a type.', 400);

  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  const args: RecordArgs = {
    p_event_id: eventId,
    p_type: type,
    p_checkout_session_id: null,
    p_provider_ref: null,
    p_amount_cents: null,
    p_currency: null,
    p_outcome: null,
    p_refunded_cents: null,
    p_payload: event as Record<string, unknown>,
    p_intent_id: null,
  };

  // Our intent id travels in Stripe metadata, so an event that has no session
  // or payment reference yet can still be matched to the right record.
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  args.p_intent_id =
    typeof metadata.intent_id === 'string' && metadata.intent_id.length > 0
      ? metadata.intent_id
      : null;

  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      args.p_checkout_session_id = text(object.id);
      args.p_provider_ref = text(object.payment_intent);
      args.p_amount_cents = amount(object.amount_total);
      args.p_currency = text(object.currency);

      if (type === 'checkout.session.expired') {
        args.p_outcome = 'cancelled';
      } else if (type === 'checkout.session.async_payment_failed') {
        args.p_outcome = 'failed';
      } else if (object.payment_status === 'paid') {
        args.p_outcome = 'paid';
      } else if (object.payment_status === 'unpaid') {
        args.p_outcome = 'pending';
      }
      break;
    }

    case 'payment_intent.succeeded': {
      args.p_provider_ref = text(object.id);
      args.p_amount_cents = amount(object.amount_received) ?? amount(object.amount);
      args.p_currency = text(object.currency);
      // checkout.session.completed (or async_payment_succeeded) is the event
      // that authorises a paid record; this one is kept as evidence only.
      break;
    }

    case 'payment_intent.payment_failed': {
      args.p_provider_ref = text(object.id);
      args.p_amount_cents = amount(object.amount);
      args.p_currency = text(object.currency);
      args.p_outcome = 'failed';
      break;
    }

    case 'charge.refunded': {
      args.p_provider_ref = text(object.payment_intent);
      args.p_amount_cents = amount(object.amount);
      args.p_currency = text(object.currency);
      args.p_refunded_cents = amount(object.amount_refunded);
      args.p_outcome =
        args.p_refunded_cents !== null && args.p_amount_cents !== null &&
        args.p_refunded_cents >= args.p_amount_cents
          ? 'refunded'
          : 'partially_refunded';
      break;
    }

    default:
      // Unhandled types are still recorded as evidence, and change nothing.
      break;
  }

  try {
    const admin = adminClient();
    const { data, error } = await admin.rpc('record_stripe_event', args);

    if (error) {
      // A database refusal means the event was not applied. Return 500 so Stripe
      // retries rather than silently dropping a payment.
      return fail(`Stripe event could not be recorded: ${error.message}`, 500);
    }

    const result = (data ?? {}) as Record<string, unknown>;

    return json({
      ok: true,
      received: true,
      eventId,
      type,
      duplicate: result.duplicate === true,
      matched: result.matched !== false,
      paid: result.paid === true,
      orderId: result.orderId ?? null,
      version: SERVICE_VERSION,
    });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(message, 500);
  }
});
