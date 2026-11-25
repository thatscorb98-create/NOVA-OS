/**
 * Public cloud configuration.
 *
 * These two values ship inside the app bundle and are safe to expose: the anon
 * key can only reach rows that row level security allows for the signed-in
 * owner. A service-role key, Stripe secret or NVIDIA key must never appear here.
 *
 * Expo inlines `process.env.EXPO_PUBLIC_*` at build time, so they are read
 * statically rather than through a dynamic lookup.
 */

const rawUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const rawAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const cloudConfig = {
  url: rawUrl.trim().replace(/\/+$/, ''),
  anonKey: rawAnonKey.trim(),
};

/** True only when both values look usable. No network call is made here. */
export const isCloudConfigured =
  /^https?:\/\/[^\s]+$/.test(cloudConfig.url) && cloudConfig.anonKey.length > 20;

/** Which variable is missing, for the setup card on the Cloud screen. */
export function missingCloudVariables(): string[] {
  const missing: string[] = [];
  if (!/^https?:\/\/[^\s]+$/.test(cloudConfig.url)) missing.push('EXPO_PUBLIC_SUPABASE_URL');
  if (cloudConfig.anonKey.length <= 20) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  return missing;
}
