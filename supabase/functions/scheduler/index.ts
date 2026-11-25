import { resolveCaller } from '../_shared/auth.ts';
import { fail, json, methodNotAllowed, preflight } from '../_shared/http.ts';
import { adminClient, SERVICE_VERSION } from '../_shared/supabase.ts';
import { runQueue } from '../_shared/worker.ts';

/**
 * Scheduler.
 *
 * Runs on a cron trigger with the shared secret (or the service role), never
 * from the phone. Each tick:
 *   1. enqueues one recovery sweep per owner, idempotent within a 5-minute bucket
 *   2. drains the queue itself, so work advances even when the app is closed
 *
 * This is what makes the queue independent of the mobile app. Until the cron is
 * configured, the app can still nudge the same code path through the worker.
 */

const SWEEP_BUCKET_MS = 5 * 60 * 1000;

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  if (req.method !== 'POST') return methodNotAllowed();

  const caller = await resolveCaller(req);
  if (!caller) return fail('Not authorized.', 401);
  if (caller.mode === 'user') {
    return fail('The scheduler runs with the cron secret or the service role.', 403);
  }

  try {
    const admin = adminClient();
    const bucket = Math.floor(Date.now() / SWEEP_BUCKET_MS);

    const { data: owners, error } = await admin.from('business_settings').select('owner_id');
    if (error) throw new Error(`Could not list owners: ${error.message}`);

    let enqueued = 0;

    for (const row of owners ?? []) {
      const ownerId = (row as { owner_id: string }).owner_id;

      const { error: enqueueError } = await admin.rpc('enqueue_agent_job', {
        p_kind: 'system.health_sweep',
        p_payload: { scheduledBy: 'scheduler', bucket },
        p_idempotency_key: `health_sweep:${bucket}`,
        p_run_after: new Date().toISOString(),
        p_priority: 200,
        p_owner_id: ownerId,
      });

      if (enqueueError) {
        throw new Error(`Could not enqueue the sweep for ${ownerId}: ${enqueueError.message}`);
      }

      enqueued += 1;
    }

    const run = await runQueue({
      admin,
      workerId: `scheduler-${crypto.randomUUID()}`,
      limit: 10,
      ownerId: null,
    });

    return json({
      ok: true,
      version: SERVICE_VERSION,
      owners: owners?.length ?? 0,
      enqueued,
      run,
    });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(message, 500);
  }
});
