import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { cloudConfig, isCloudConfigured } from '@/lib/cloud/config';

/**
 * The Supabase client for the app.
 *
 * Returns null when the project is not configured, so every cloud surface can
 * degrade to "offline" instead of throwing. The session is persisted in
 * AsyncStorage and refreshed in the background; the app never holds a
 * service-role key.
 */

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!isCloudConfigured) return null;
  if (cached) return cached;

  cached = createClient(cloudConfig.url, cloudConfig.anonKey, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });

  return cached;
}
