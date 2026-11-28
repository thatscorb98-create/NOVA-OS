import { resolveCaller } from '../_shared/auth.ts';
import { fail, json, preflight } from '../_shared/http.ts';
import { adminClient, env, SERVICE_VERSION } from '../_shared/supabase.ts';

/**
 * Stripe checkout.
 *
 *   POST { quoteId }   the signed-in owner opens checkout for an accepted quote
 *   GET  ?checkout=…  the customer's return page after paying or cancelling
 *
 * The Stripe secret key lives in Supabase secrets and is never returned to the
 * app or written to a row. Checkout is created only for an accepted quote while
 * the owner has payments switched on; the database function re-checks both.
 *
 * Live mode is refused unless the owner has turned `stripe_live_mode` on. With
 * a test key everything stays in Stripe's sandbox.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
};

interface QuoteRow {
  id: string;
  owner_id: string;
  lead_id: string | null;
  title: string;
  amount_cents: number;
  currency: string;
  status: string;
  expires_at: string | null;
}

interface IntentRow {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  checkout_url: string | null;
  checkout_session_id: string | null;
  checkout_expires_at: string | null;
}

interface SettingsRow {
  payments_live: boolean;
  stripe_live_mode: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents: number, currency: string): string {
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `;
  return `${symbol}${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #04050a; color: #e8ecf8; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 520px; border: 1px solid #1d2438; border-radius: 18px;
    background: #0a0e1c; padding: 26px; }
  .eyebrow { font-size: 11px; letter-spacing: 2px; color: #7c89a8; text-transform: uppercase; }
  h1 { font-size: 21px; line-height: 1.3; margin: 10px 0 4px; }
  .amount { font-size: 34px; font-weight: 600; margin: 18px 0 6px; color: #22d3ee; }
  .meta { font-size: 13px; color: #9aa6c4; line-height: 1.6; }
  .ok { color: #86efac; }
  .bad { color: #fca5a5; }
  .note { margin-top: 20px; font-size: 12px; line-height: 1.55; color: #7c89a8; }
</style>
</head>
<body><main>${body}</main></body>
</html>`,
    { status: 200, headers: PAGE_HEADERS },
  );
}

async function receiptPage(sessionId: string): Promise<Response> {
  const admin = adminClient();
  const { data } = await admin
    .from('payment_intents')
    .select('id, status, amount_cents, currency')
    .eq('checkout_session_id', sessionId)
    .maybeSingle();

  const intent = data as { status: string; amount_cents: number; currency: string } | null;

  if (!intent) {
    return page(
      'Payment status',
      `<div class="eyebrow">NOVA OS · PAYMENT</div>
<div class="meta">This checkout reference is not on file yet. If you just paid, Stripe can take a
moment to confirm it. The business will see the verified status in its workspace.</div>`,
    );
  }

  const paid = ['succeeded', 'refunded', 'partially_refunded'].includes(intent.status);
  const failed = ['failed', 'cancelled'].includes(intent.status);

  return page(
    paid ? 'Payment received' : 'Payment status',
    `<div class="eyebrow">NOVA OS · PAYMENT</div>
<h1 class="${paid ? 'ok' : failed ? 'bad' : ''}">${
      paid ? 'Payment confirmed' : failed ? 'Payment not completed' : 'Waiting for Stripe'
    }</h1>
<div class="amount">${escapeHtml(money(intent.amount_cents, intent.currency))}</div>
<div class="meta">${
      paid
        ? 'Stripe confirmed this payment. A receipt was emailed by Stripe when your card was charged.'
        : failed
          ? 'Stripe reported that this checkout did not complete. Nothing was collected.'
          : 'Stripe has not confirmed this payment yet. This page does not record a payment.'
    }</div>
<div class="note">You can close this page. This screen is only a status view; the payment is
recorded by Stripe's signed webhook, not by this page.</div>`,
  );
}

async function createCheckout(req: Request): Promise<Response> {
  const caller = await resolveCaller(req);
  if (!caller || caller.mode !== 'user' || !caller.ownerId) {
    return fail('Sign in to create a checkout.', 401);
  }

  let body: { quoteId?: unknown };
  try {
    body = (await req.json()) as { quoteId?: unknown };
  } catch {
    return fail('A JSON body is required.');
  }

  const quoteId = typeof body.quoteId === 'string' ? body.quoteId : '';
  if (!UUID.test(quoteId)) return fail('A valid quoteId is required.');

  const key = env('STRIPE_SECRET_KEY');
  if (!key) {
    return fail(
      'No payment provider is connected: STRIPE_SECRET_KEY is not set for this project, so no checkout was created.',
      503,
    );
  }

  if (!key.startsWith('sk_test_') && !key.startsWith('sk_live_')) {
    return fail('The configured Stripe key is not a secret key (sk_test_… or sk_live_…).', 503);
  }

  const admin = adminClient();

  const { data: quoteData, error: quoteError } = await admin
    .from('quotes')
    .select('id, owner_id, lead_id, title, amount_cents, currency, status, expires_at')
    .eq('id', quoteId)
    .eq('owner_id', caller.ownerId)
    .maybeSingle();

  if (quoteError) return fail(quoteError.message, 500);

  const quote = quoteData as QuoteRow | null;
  if (!quote) return fail('That quote does not exist for this owner.', 404);

  if (quote.status !== 'accepted') {
    return fail(
      `The quote is "${quote.status}". Checkout exists only after the customer accepts, in writing, the scope and price.`,
      409,
    );
  }

  if (quote.expires_at && Date.parse(quote.expires_at) <= Date.now() + 31 * 60 * 1000) {
    return fail('This quote expires too soon for a checkout (Stripe needs at least 30 minutes).', 409);
  }

  const { data: settingsData, error: settingsError } = await admin
    .from('business_settings')
    .select('payments_live, stripe_live_mode')
    .eq('owner_id', caller.ownerId)
    .maybeSingle();

  if (settingsError) return fail(settingsError.message, 500);

  const settings = settingsData as SettingsRow | null;
  if (!settings?.payments_live) {
    return fail('Payments are switched off in company settings, so no checkout was created.', 409);
  }

  const liveKey = key.startsWith('sk_live_');
  if (liveKey && !settings.stripe_live_mode) {
    return fail(
      'A live Stripe key is configured but live mode is off. Turn live mode on only after a passing test run.',
      409,
    );
  }

  const { data: intentData, error: intentError } = await admin.rpc('create_checkout_intent', {
    p_quote_id: quote.id,
  });

  if (intentError) return fail(intentError.message, 409);

  let intent = (Array.isArray(intentData) ? intentData[0] : intentData) as IntentRow | null;
  if (!intent?.id) return fail('The database returned no payment record.', 500);

  // A live, unexpired session is reused instead of opening a second one.
  if (
    intent.checkout_url &&
    intent.status === 'checkout_created' &&
    (!intent.checkout_expires_at || Date.parse(intent.checkout_expires_at) > Date.now() + 5 * 60 * 1000)
  ) {
    return json({
      ok: true,
      url: intent.checkout_url,
      intentId: intent.id,
      mode: liveKey ? 'live' : 'test',
      reused: true,
      version: SERVICE_VERSION,
    });
  }

  const base = `${env('SUPABASE_URL')}/functions/v1/payments`;
  const expiresAt = Math.floor(
    Math.min(
      Date.now() + 24 * 60 * 60 * 1000,
      quote.expires_at ? Date.parse(quote.expires_at) : Number.POSITIVE_INFINITY,
    ) / 1000,
  );

  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('client_reference_id', intent.id);
  form.set('success_url', `${base}?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set('cancel_url', `${base}?checkout=cancelled`);
  form.set('expires_at', String(expiresAt));
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', quote.currency);
  form.set('line_items[0][price_data][unit_amount]', String(quote.amount_cents));
  form.set('line_items[0][price_data][product_data][name]', quote.title.slice(0, 240));
  form.set('metadata[intent_id]', intent.id);
  form.set('metadata[quote_id]', quote.id);
  form.set('metadata[owner_id]', quote.owner_id);
  form.set('payment_intent_data[metadata][intent_id]', intent.id);
  form.set('payment_intent_data[metadata][quote_id]', quote.id);

  // Keep Stripe's {CHECKOUT_SESSION_ID} literal; only the rest is form-encoded.
  const requestBody = form
    .toString()
    .replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');

  let session: {
    id?: string;
    url?: string;
    expires_at?: number;
    error?: { message?: string };
  };

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // A retried request reuses the same session instead of opening another.
        'Idempotency-Key': `nova-checkout-${intent.id}-${expiresAt}`,
      },
      body: requestBody,
    });

    session = (await response.json()) as typeof session;

    if (!response.ok || !session.id || !session.url) {
      const message = session.error?.message ?? `Stripe returned ${response.status}.`;
      return fail(`Stripe did not create the checkout: ${message}`, 502);
    }
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(`Could not reach Stripe: ${message}`, 502);
  }

  const sessionExpiry = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : null;

  const { data: attached, error: attachError } = await admin.rpc('attach_checkout_session', {
    p_intent_id: intent.id,
    p_session_id: session.id,
    p_url: session.url,
    p_expires_at: sessionExpiry,
  });

  if (attachError) return fail(attachError.message, 500);

  intent = (Array.isArray(attached) ? attached[0] : attached) as IntentRow | null;

  return json({
    ok: true,
    url: intent?.checkout_url ?? session.url,
    intentId: intent?.id ?? null,
    mode: liveKey ? 'live' : 'test',
    expiresAt: sessionExpiry,
    version: SERVICE_VERSION,
  });
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      if (url.searchParams.get('checkout') === 'cancelled') {
        return page(
          'Checkout cancelled',
          `<div class="eyebrow">NOVA OS · PAYMENT</div>
<h1>Checkout cancelled</h1>
<div class="meta">Nothing was collected. You can close this page and ask for a fresh link when you
are ready.</div>`,
        );
      }

      const sessionId = url.searchParams.get('session_id') ?? '';
      if (sessionId.length < 6) {
        return page(
          'Payment status',
          `<div class="eyebrow">NOVA OS · PAYMENT</div>
<div class="meta">No checkout reference was supplied.</div>`,
        );
      }

      return await receiptPage(sessionId);
    }

    if (req.method === 'POST') return await createCheckout(req);

    return fail('Use POST to create a checkout or GET for the return page.', 405);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(message, 500);
  }
});
