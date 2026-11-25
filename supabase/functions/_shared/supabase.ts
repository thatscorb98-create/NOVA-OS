import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const SERVICE_VERSION = 'phase1.0.0';

export function env(name: string): string | null {
  const value = Deno.env.get(name);
  return value && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Service-role client.
 *
 * Only ever constructed inside an edge function. The key is injected by the
 * Supabase runtime and is never sent to the app, logged, or written to a row.
 */
export function adminClient(): SupabaseClient {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be available to this function.');
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-nova-service': SERVICE_VERSION } },
  });
}
