import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  ActivityEvent,
  AgentId,
  AgentState,
  AppSettings,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  Message,
  Mission,
  Project,
} from '@/types/nova';
import { DEFAULT_MODEL, isKnownModel } from '@/lib/model/models';
import { createId } from '@/lib/id';

const STATE_KEY = 'nova-os.state.v3';
const LEGACY_V2_KEY = 'nova-os.state.v2';
const LEGACY_V1_KEY = 'nova-os.state.v1';

export interface PersistedState {
  missions: Mission[];
  projects: Project[];
  messages: Message[];
  activity: ActivityEvent[];
  threads: Record<string, Message[]>;
  memories: MemoryRecord[];
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
    memories: [],
    agents: {},
    settings: { model: DEFAULT_MODEL },
  };
}

const SCOPES: MemoryScope[] = ['global', 'project', 'agent', 'conversation'];
const KINDS: MemoryKind[] = ['fact', 'preference', 'decision', 'summary', 'note'];
const SOURCES: MemorySource[] = ['user', 'agent', 'nova', 'mission', 'conversation'];

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeMemories(value: unknown): MemoryRecord[] {
  return asArray<Partial<MemoryRecord>>(value)
    .filter((memory) => memory && typeof memory.id === 'string' && typeof memory.text === 'string')
    .map((memory) => {
      const text = String(memory.text).trim().slice(0, 1200);
      const createdAt = typeof memory.createdAt === 'number' ? memory.createdAt : Date.now();

      return {
        id: String(memory.id),
        text,
        scope: pick(memory.scope, SCOPES, 'global'),
        kind: pick(memory.kind, KINDS, 'note'),
        source: pick(memory.source, SOURCES, 'user'),
        agentId: optionalString(memory.agentId) as AgentId | undefined,
        projectId: optionalString(memory.projectId),
        conversationId: optionalString(memory.conversationId),
        tags: asArray<unknown>(memory.tags)
          .filter((tag): tag is string => typeof tag === 'string')
          .slice(0, 8),
        pinned: Boolean(memory.pinned),
        createdAt,
        updatedAt: typeof memory.updatedAt === 'number' ? memory.updatedAt : createdAt,
      };
    })
    .filter((memory) => memory.text.length > 0);
}

/**
 * Phase Two stored one flat note list per agent. Convert those notes into the
 * Phase Three memory ledger so nothing the agents learned is lost.
 */
function migrateAgentNotes(value: unknown): MemoryRecord[] {
  const memoryMap = asRecord<{ notes?: unknown }>(value);
  const migrated: MemoryRecord[] = [];

  for (const [agentId, entry] of Object.entries(memoryMap)) {
    for (const note of asArray<Partial<{ id: string; text: string; createdAt: number; source: string }>>(
      entry?.notes,
    )) {
      if (!note || typeof note.text !== 'string' || note.text.trim().length === 0) continue;
      const createdAt = typeof note.createdAt === 'number' ? note.createdAt : Date.now();
      const knownAgent = KNOWN_AGENT_IDS.includes(agentId as AgentId)
        ? (agentId as AgentId)
        : undefined;

      migrated.push({
        id: typeof note.id === 'string' ? note.id : createId('mem'),
        text: note.text.trim().slice(0, 1200),
        scope: 'agent',
        kind: 'note',
        source:
          note.source === 'mission' ? 'mission' : note.source === 'agent' ? 'agent' : 'user',
        agentId: knownAgent,
        tags: [],
        pinned: false,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  return migrated;
}

function normalize(raw: string | null, migrateNotes: boolean): PersistedState | null {
  if (!raw) return null;

  const parsed = JSON.parse(raw) as Partial<PersistedState> & { memory?: unknown };
  const settings = parsed.settings;
  const model =
    settings && typeof settings.model === 'string' && isKnownModel(settings.model)
      ? settings.model
      : DEFAULT_MODEL;

  const memories = migrateNotes
    ? migrateAgentNotes(parsed.memory)
    : normalizeMemories(parsed.memories);

  return {
    missions: asArray<Mission>(parsed.missions),
    projects: asArray<Project>(parsed.projects),
    messages: asArray<Message>(parsed.messages),
    activity: asArray<ActivityEvent>(parsed.activity),
    threads: asRecord<Message[]>(parsed.threads),
    memories,
    agents: asRecord<AgentState>(parsed.agents),
    settings: { model },
  };
}

/**
 * Loads the local workspace from disk. Storage is AsyncStorage, which persists
 * across app restarts and reboots — the workspace is never held only in memory.
 * Older state versions are migrated forward.
 */
export async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const current = normalize(await AsyncStorage.getItem(STATE_KEY), false);
    if (current) return current;

    const v2 = normalize(await AsyncStorage.getItem(LEGACY_V2_KEY), true);
    if (v2) return v2;

    const v1 = normalize(await AsyncStorage.getItem(LEGACY_V1_KEY), false);
    return v1;
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
    await AsyncStorage.multiRemove([STATE_KEY, LEGACY_V2_KEY, LEGACY_V1_KEY]);
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
