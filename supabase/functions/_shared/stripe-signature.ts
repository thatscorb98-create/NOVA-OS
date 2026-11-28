/**
 * Stripe webhook signature verification.
 *
 * Stripe signs `${timestamp}.${raw body}` with HMAC-SHA256 and sends
 * `t=<seconds>,v1=<hex>` in the `Stripe-Signature` header. The comparison is
 * constant-time and the timestamp has a five-minute tolerance, so a captured
 * body cannot be replayed indefinitely.
 *
 * This lives outside the function entrypoint so Phase 9 can test it directly.
 */

export const STRIPE_TOLERANCE_SECONDS = 300;

export interface SignatureResult {
  ok: boolean;
  reason?: string;
}

export function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export async function signStripePayload(
  payload: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return hex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`)),
  );
}

export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<SignatureResult> {
  const parts = header.split(',').map((part) => part.trim());
  let timestamp = '';
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value ?? '';
    if (key === 'v1' && value) signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) {
    return { ok: false, reason: 'missing timestamp or signature' };
  }

  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'bad timestamp' };

  if (Math.abs(nowMs / 1000 - seconds) > STRIPE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const expected = await signStripePayload(payload, timestamp, secret);

  return signatures.some((signature) => safeEqualHex(expected, signature))
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}
