import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  ActivityEvent,
  AgentId,
  AgentMemory,
  AgentState,
  AppSettings,
  Message,
  Mission,
  Project,
} from '@/types/nova';
import { DEFAULT_MODEL, isKnownModel } from '@/lib/model/models';

const STATE_KEY = 'nova-os.state.v2';
const LEGACY_STATE_KEY = 'nova-os.state.v1';

export interface PersistedState {
  missions: Mission[];
  projects: Project[];
  messages: Message[];
  activity: ActivityEvent[];
  threads: Record<string, Message[]>;
  memory: Record<string, AgentMemory>;
  agents: Record<string, AgentState>;
  settings: AppSettings;
}

export function emptyState(): PersistedState {
  return {
    missions: [],
    projects: [],
    messages: [],
    activity: [],
    threads: {},
    memory: {},
    agents: {},
    settings: { model: DEFAULT_MODEL },
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function normalize(raw: string | null): PersistedState | null {
  if (!raw) return null;

  const parsed = JSON.parse(raw) as Partial<PersistedState>;
  const settings = parsed.settings;
  const model =
    settings && typeof settings.model === 'string' && isKnownModel(settings.model)
      ? settings.model
      : DEFAULT_MODEL;

  return {
    missions: asArray<Mission>(parsed.missions),
    projects: asArray<Project>(parsed.projects),
    messages: asArray<Message>(parsed.messages),
    activity: asArray<ActivityEvent>(parsed.activity),
    threads: asRecord<Message[]>(parsed.threads),
    memory: asRecord<AgentMemory>(parsed.memory),
    agents: asRecord<AgentState>(parsed.agents),
    settings: { model },
  };
}

/**
 * Loads the local workspace, migrating Phase One data into the Phase Two shape.
 * Corrupt or partial data is repaired instead of crashing the app.
 */
export async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const current = normalize(await AsyncStorage.getItem(STATE_KEY));
    if (current) return current;

    const legacy = normalize(await AsyncStorage.getItem(LEGACY_STATE_KEY));
    return legacy;
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
    await AsyncStorage.multiRemove([STATE_KEY, LEGACY_STATE_KEY]);
  } catch (error) {
    console.warn('[nova] failed to clear local state', error);
  }
}

/** Agent ids that must always have a state entry. */
export const KNOWN_AGENT_IDS: AgentId[] = [
  'nova',
  'atlas',
  'forge',
  'echo',
  'sterling',
  'relay',
  'sentinel',
];
