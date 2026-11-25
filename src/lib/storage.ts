import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ActivityEvent, Message, Mission, Project } from '@/types/nova';

const STATE_KEY = 'nova-os.state.v1';

export interface PersistedState {
  missions: Mission[];
  projects: Project[];
  messages: Message[];
  activity: ActivityEvent[];
}

const emptyState: PersistedState = {
  missions: [],
  projects: [],
  messages: [],
  activity: [],
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Loads the local workspace. Corrupt or partial data is repaired to a valid
 * shape instead of crashing the app.
 */
export async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      missions: asArray<Mission>(parsed.missions),
      projects: asArray<Project>(parsed.projects),
      messages: asArray<Message>(parsed.messages),
      activity: asArray<ActivityEvent>(parsed.activity),
    };
  } catch (error) {
    console.warn('[nova] failed to load local state', error);
    return null;
  }
}

export async function savePersistedState(state: PersistedState): Promise<void> {
  try {
    await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[nova] failed to save local state', error);
  }
}

export async function clearPersistedState(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STATE_KEY);
  } catch (error) {
    console.warn('[nova] failed to clear local state', error);
  }
}

export const EMPTY_STATE = emptyState;
