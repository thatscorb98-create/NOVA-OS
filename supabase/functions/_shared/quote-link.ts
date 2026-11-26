import { env } from './supabase.ts';

/**
 * Signed acceptance links.
 *
 * The token is an HMAC over the quote id and an expiry time. Nothing is stored,
 * so a quote id alone is not enough to accept an offer: without the signature the
 * public endpoint refuses. The signing key is a function secret (QUOTE_LINK_SECRET,
 * falling back to WORKER_SECRET) and never reaches the app.
 */

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function secret(): string {
  const value = env('QUOTE_LINK_SECRET') ?? env('WORKER_SECRET');
  if (!value) {
    throw new Error(
      'No signing secret is available. Set QUOTE_LINK_SECRET (or WORKER_SECRET) as a function secret.',
    );
  }
  return value;
}

async function key(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signature(quoteId: string, expiresAtSeconds: number): Promise<string> {
  const message = `nova.quote:${quoteId}:${expiresAtSeconds}`;
  const bytes = await crypto.subtle.sign('HMAC', await key(), encoder.encode(message));
  return base64Url(new Uint8Array(bytes));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/** Token shape: `<quote-uuid>.<expiry-epoch-seconds>.<hmac>`. */
export async function signQuoteToken(quoteId: string, expiresAt: Date): Promise<string> {
  const seconds = Math.floor(expiresAt.getTime() / 1000);
  return `${quoteId}.${seconds}.${await signature(quoteId, seconds)}`;
}

export type QuoteTokenResult =
  | { ok: true; quoteId: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid' };

export async function verifyQuoteToken(
  token: string,
  now = Date.now(),
): Promise<QuoteTokenResult> {
  const parts = (token ?? '').trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [quoteId, rawSeconds, provided] = parts;
  const seconds = Number.parseInt(rawSeconds, 10);

  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !Number.isFinite(seconds) || !provided) {
    return { ok: false, reason: 'malformed' };
  }

  if (seconds * 1000 <= now) return { ok: false, reason: 'expired' };

  const expected = await signature(quoteId, seconds);
  if (!safeEqual(expected, provided)) return { ok: false, reason: 'invalid' };

  return { ok: true, quoteId };
}

/** Only https links to the project's own function origin are ever minted. */
export function quoteLinkUrl(token: string): string {
  const base = (env('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) {
    throw new Error('SUPABASE_URL is not available to this function.');
  }
  return `${base}/functions/v1/quote?token=${encodeURIComponent(token)}`;
}
