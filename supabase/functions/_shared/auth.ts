import { adminClient, env } from './supabase.ts';

/**
 * Who is calling an edge function.
 *
 *  - service : the service-role key. May act for any owner (cron, admin tools).
 *  - user    : a signed-in owner. Strictly scoped to their own rows.
 *  - cron    : the shared scheduler secret. May act for any owner.
 *
 * Anything else is rejected. There is no anonymous path into the queue.
 */
export type CallerMode = 'service' | 'user' | 'cron';

export interface Caller {
  mode: CallerMode;
  ownerId: string | null;
  label: string;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export async function resolveCaller(req: Request): Promise<Caller | null> {
  const cronSecret = env('WORKER_SECRET');
  const providedSecret = req.headers.get('x-worker-secret');

  if (cronSecret && providedSecret && safeEqual(cronSecret, providedSecret)) {
    return { mode: 'cron', ownerId: null, label: 'scheduler' };
  }

  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

  if (!token) return null;

  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (serviceKey && token === serviceKey) {
    return { mode: 'service', ownerId: null, label: 'service' };
  }

  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);

  if (error || !data?.user) return null;

  return {
    mode: 'user',
    ownerId: data.user.id,
    label: data.user.email ?? data.user.id,
  };
}
