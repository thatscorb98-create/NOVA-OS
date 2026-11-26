import { resolveCaller } from '../_shared/auth.ts';
import { fail, json, preflight } from '../_shared/http.ts';
import { quoteLinkUrl, signQuoteToken, verifyQuoteToken } from '../_shared/quote-link.ts';
import { adminClient, SERVICE_VERSION } from '../_shared/supabase.ts';

/**
 * Quote acceptance.
 *
 *   GET  ?token=…            the customer's page, read only
 *   POST form token=…        records acceptance, then shows the receipt
 *   POST JSON {quoteId}      mints a signed link for the signed-in owner
 *
 * The public paths never see the service key or another owner's data: the token
 * is verified first, and the quote is then loaded by its own id. Acceptance is
 * performed by the database function, which refuses anything that is not a sent,
 * unexpired quote. No payment is taken here and no card details are requested.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface QuoteRow {
  id: string;
  owner_id: string;
  lead_id: string | null;
  title: string;
  scope: string;
  amount_cents: number;
  currency: string;
  status: string;
  delivery_days: number;
  expires_at: string | null;
  accepted_at: string | null;
}

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

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
  .business { color: #9aa6c4; font-size: 14px; margin-bottom: 18px; }
  .amount { font-size: 34px; font-weight: 600; margin: 18px 0 6px; color: #22d3ee; }
  .meta { font-size: 13px; color: #9aa6c4; }
  .scope { margin-top: 18px; padding: 14px; border-radius: 12px; background: #070a14;
    border: 1px solid #161d2f; font-size: 14px; line-height: 1.55; color: #cbd4ea; white-space: pre-wrap; }
  .note { margin-top: 20px; font-size: 12px; line-height: 1.55; color: #7c89a8; }
  button { width: 100%; margin-top: 20px; padding: 15px; border-radius: 12px; border: 1px solid #4ade80;
    background: #0f2a1f; color: #86efac; font-size: 15px; font-weight: 600; letter-spacing: 0.5px; }
  .ok { border-color: #4ade80; }
  .bad { border-color: #f87171; }
  .title { font-size: 18px; font-weight: 600; margin: 8px 0 10px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`,
    { status: 200, headers: PAGE_HEADERS },
  );
}

function errorPage(title: string, message: string): Response {
  return page(
    title,
    `<div class="eyebrow">NOVA OS</div>
<div class="title bad">${escapeHtml(title)}</div>
<div class="meta">${escapeHtml(message)}</div>
<div class="note">If you were not expecting this page, close it. Nothing was recorded.</div>`,
  );
}

async function loadQuote(quoteId: string): Promise<QuoteRow | null> {
  const admin = adminClient();
  const { data, error } = await admin
    .from('quotes')
    .select(
      'id, owner_id, lead_id, title, scope, amount_cents, currency, status, delivery_days, expires_at, accepted_at',
    )
    .eq('id', quoteId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as QuoteRow | null) ?? null;
}

async function businessName(leadId: string | null): Promise<string | null> {
  if (!leadId) return null;
  const admin = adminClient();
  const { data } = await admin.from('leads').select('business_name').eq('id', leadId).maybeSingle();
  return (data as { business_name?: string } | null)?.business_name ?? null;
}

function quoteCard(quote: QuoteRow, name: string | null, action: string): string {
  const expiry = quote.expires_at
    ? `<div class="meta">Offer valid until ${escapeHtml(new Date(quote.expires_at).toUTCString())}</div>`
    : '';

  return `<div class="eyebrow">NOVA OS · QUOTE</div>
<h1>${escapeHtml(quote.title)}</h1>
${name ? `<div class="business">${escapeHtml(name)}</div>` : ''}
<div class="amount">${escapeHtml(money(quote.amount_cents, quote.currency))}</div>
<div class="meta">Delivery in ${quote.delivery_days} day(s) · ${escapeHtml(quote.currency.toUpperCase())}</div>
${expiry}
${quote.scope ? `<div class="scope">${escapeHtml(quote.scope)}</div>` : ''}
${action}
<div class="note">Accepting records your agreement to this offer. No payment is taken on this page and no card details are requested.</div>`;
}

async function showQuote(token: string): Promise<Response> {
  const verified = await verifyQuoteToken(token);
  if (!verified.ok) {
    return errorPage(
      verified.reason === 'expired' ? 'This link has expired' : 'This link is not valid',
      verified.reason === 'expired'
        ? 'Ask for a fresh acceptance link.'
        : 'The link is incomplete or has been altered.',
    );
  }

  const quote = await loadQuote(verified.quoteId);
  if (!quote) {
    return errorPage('This quote is unavailable', 'It may have been withdrawn.');
  }

  const name = await businessName(quote.lead_id);

  if (quote.status === 'accepted') {
    return page(
      'Quote accepted',
      `<div class="eyebrow">NOVA OS · QUOTE</div>
<div class="title ok">Already accepted</div>
<div class="meta">${escapeHtml(quote.title)} · ${escapeHtml(
        money(quote.amount_cents, quote.currency),
      )}</div>
<div class="note">This offer was accepted${
        quote.accepted_at ? ` on ${escapeHtml(new Date(quote.accepted_at).toUTCString())}` : ''
      }. Nothing was charged.</div>`,
    );
  }

  if (quote.status === 'declined' || quote.status === 'expired') {
    return errorPage('This quote is closed', 'It is no longer open for acceptance.');
  }

  if (quote.status !== 'sent') {
    return errorPage('This quote is not ready', 'The sender has not released this offer yet.');
  }

  if (quote.expires_at && Date.parse(quote.expires_at) <= Date.now()) {
    return errorPage('This link has expired', 'The offer passed its expiry date.');
  }

  const action = `<form method="POST" action="">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <button type="submit">Accept this quote</button>
</form>`;

  return page('Accept quote', quoteCard(quote, name, action));
}

async function acceptQuote(token: string): Promise<Response> {
  const verified = await verifyQuoteToken(token);
  if (!verified.ok) {
    return errorPage(
      verified.reason === 'expired' ? 'This link has expired' : 'This link is not valid',
      'Nothing was recorded. Ask for a fresh acceptance link.',
    );
  }

  const admin = adminClient();
  const { data, error } = await admin.rpc('accept_quote', {
    p_quote_id: verified.quoteId,
    p_via: 'link',
    p_accepted_by: 'accepted from the quote link',
  });

  if (error) {
    const quote = await loadQuote(verified.quoteId);
    if (quote?.status === 'accepted') {
      return page(
        'Quote accepted',
        `<div class="eyebrow">NOVA OS · QUOTE</div>
<div class="title ok">Already accepted</div>
<div class="meta">${escapeHtml(quote.title)}</div>
<div class="note">This offer had already been accepted. Nothing was charged.</div>`,
      );
    }
    return errorPage('This quote could not be accepted', error.message);
  }

  const quote = (Array.isArray(data) ? data[0] : data) as QuoteRow | null;
  if (!quote?.id) {
    return errorPage('This quote could not be accepted', 'The database returned no quote.');
  }

  const name = await businessName(quote.lead_id);

  return page(
    'Quote accepted',
    `<div class="eyebrow">NOVA OS · QUOTE</div>
<div class="title ok">Accepted</div>
<h1>${escapeHtml(quote.title)}</h1>
${name ? `<div class="business">${escapeHtml(name)}</div>` : ''}
<div class="amount">${escapeHtml(money(quote.amount_cents, quote.currency))}</div>
<div class="meta">Delivery in ${quote.delivery_days} day(s)</div>
<div class="note">Your acceptance was recorded. No payment was taken and no card details were requested. The sender will follow up with next steps.</div>`,
  );
}

async function mintLink(req: Request): Promise<Response> {
  const caller = await resolveCaller(req);
  if (!caller || caller.mode !== 'user' || !caller.ownerId) {
    return fail('Sign in to create an acceptance link.', 401);
  }

  let body: { quoteId?: unknown };
  try {
    body = (await req.json()) as { quoteId?: unknown };
  } catch {
    return fail('A JSON body is required.');
  }

  const quoteId = typeof body.quoteId === 'string' ? body.quoteId : '';
  if (!UUID.test(quoteId)) return fail('A valid quoteId is required.');

  const admin = adminClient();
  const { data, error } = await admin
    .from('quotes')
    .select('id, owner_id, status, expires_at')
    .eq('id', quoteId)
    .eq('owner_id', caller.ownerId)
    .maybeSingle();

  if (error) return fail(error.message, 500);

  const quote = data as { status: string; expires_at: string | null } | null;
  if (!quote) return fail('That quote does not exist for this owner.', 404);
  if (quote.status !== 'sent') return fail('Only a sent quote has an acceptance link.');
  if (quote.expires_at && Date.parse(quote.expires_at) <= Date.now()) {
    return fail('This quote has expired.');
  }

  const expiresAt = quote.expires_at
    ? new Date(quote.expires_at)
    : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const token = await signQuoteToken(quoteId, expiresAt);

  return json({
    ok: true,
    url: quoteLinkUrl(token),
    expires_at: expiresAt.toISOString(),
    version: SERVICE_VERSION,
  });
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    if (req.method === 'GET') {
      const token = new URL(req.url).searchParams.get('token') ?? '';
      if (!token) return errorPage('No quote was linked', 'The link is incomplete.');
      return await showQuote(token);
    }

    if (req.method === 'POST') {
      const contentType = req.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) return await mintLink(req);

      const form = new URLSearchParams(await req.text());
      const token = form.get('token') ?? '';
      if (!token) return errorPage('No quote was linked', 'The link is incomplete.');
      return await acceptQuote(token);
    }

    return fail('Use GET or POST.', 405);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return errorPage('Something went wrong', message);
  }
});
