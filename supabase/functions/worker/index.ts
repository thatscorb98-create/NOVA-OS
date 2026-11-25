import { resolveCaller } from '../_shared/auth.ts';
import { fail, json, methodNotAllowed, preflight } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import { runQueue } from '../_shared/worker.ts';

/**
 * Worker.
 *
 * A signed-in owner may drain their own queue (this is what the app's
 * "Run worker now" button does). The scheduler and the service role may drain
 * every queue. An anonymous caller gets nothing.
 */
Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  if (req.method !== 'POST') return methodNotAllowed();

  const caller = await resolveCaller(req);
  if (!caller) return fail('Not authorized.', 401);

  let limit = 3;
  try {
    const body = await req.json();
    if (body && typeof body.limit === 'number') limit = body.limit;
  } catch {
    // An empty body is fine; the default limit applies.
  }

  try {
    const admin = adminClient();
    const workerId = `worker-${crypto.randomUUID()}`;
    const summary = await runQueue({ admin, workerId, limit, ownerId: caller.ownerId });

    return json({ ok: true, caller: caller.mode, ...summary });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(message, 500);
  }
});
