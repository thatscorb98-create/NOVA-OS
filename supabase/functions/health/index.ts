import { json, preflight } from '../_shared/http.ts';
import { knownJobKinds } from '../_shared/jobs.ts';
import { env, SERVICE_VERSION } from '../_shared/supabase.ts';

/**
 * Health check.
 *
 * Public on purpose, and deliberately uninformative: it confirms the backend is
 * deployed and reachable, nothing about any owner's data. Per-owner health is
 * read by the app through the business_health RPC, which is RLS scoped.
 */
Deno.serve((req) => {
  const early = preflight(req);
  if (early) return early;

  return json({
    ok: true,
    service: 'nova-cloud',
    phase: 'phase1',
    version: SERVICE_VERSION,
    time: new Date().toISOString(),
    // Booleans only — never the values themselves.
    configured: {
      database: Boolean(env('SUPABASE_URL') && env('SUPABASE_SERVICE_ROLE_KEY')),
      cronSecret: Boolean(env('WORKER_SECRET')),
    },
    jobKinds: knownJobKinds(),
  });
});
