/** Shared HTTP helpers for the NOVA OS edge functions. */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-worker-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/** Answer the browser preflight and return null for real requests. */
export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  return null;
}

export function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

export function methodNotAllowed(): Response {
  return fail('Use POST.', 405);
}
