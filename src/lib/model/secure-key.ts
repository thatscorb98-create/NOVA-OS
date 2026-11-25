import * as SecureStore from 'expo-secure-store';

/**
 * The NVIDIA NIM API key never touches the repository, the JavaScript bundle or
 * AsyncStorage. It lives in Android's encrypted keystore (iOS Keychain) via
 * expo-secure-store and is only read when a request is made.
 */

const API_KEY_ENTRY = 'nova.nim.apiKey';

export async function readApiKey(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(API_KEY_ENTRY);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch (error) {
    console.warn('[nova] could not read the API key', error);
    return null;
  }
}

export async function writeApiKey(key: string): Promise<void> {
  const trimmed = key.trim();

  if (trimmed.length < 16) {
    throw new Error('That key looks too short. Paste the full key from build.nvidia.com.');
  }

  await SecureStore.setItemAsync(API_KEY_ENTRY, trimmed);
}

export async function deleteApiKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(API_KEY_ENTRY);
  } catch (error) {
    console.warn('[nova] could not delete the API key', error);
  }
}

/** Only for display: never log or render the real key. */
export function maskKey(key: string): string {
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
}
