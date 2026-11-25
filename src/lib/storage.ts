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
  MissionApproval,
  MissionBudget,
  MissionEvent,
  MissionKind,
  MissionReport,
  MissionResult,
  MissionRunMode,
  MissionStatus,
  MissionTask,
  MissionTaskStatus,
  Project,
} from '@/types/nova';
import { DEFAULT_MODEL, isKnownModel } from '@/lib/model/models';
import { createId } from '@/lib/id';
import { defaultMissionBudget, MISSION_LIMITS } from '@/lib/mission';

const STATE_KEY = 'nova-os.state.v4';
const LEGACY_V3_KEY = 'nova-os.state.v3';
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
const MISSION_STATUSES: MissionStatus[] = [
  'queued',
  'planning',
  'awaiting_approval',
  'active',
  'reviewing',
  'complete',
  'failed',
  'cancelled',
];
const TASK_STATUSES: MissionTaskStatus[] = [
  'queued',
  'running',
  'review',
  'complete',
  'failed',
  'blocked',
];

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

function normalizeResult(value: unknown): MissionResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Partial<MissionResult>;
  if (typeof result.text !== 'string') return undefined;

  return {
    text: result.text,
    agentId: isAgentId(result.agentId) ? result.agentId : 'nova',
    model: typeof result.model === 'string' ? result.model : 'unknown',
    createdAt: typeof result.createdAt === 'number' ? result.createdAt : Date.now(),
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
    steps: asArray<unknown>(result.steps)
      .filter((step): step is string => typeof step === 'string')
      .slice(0, 40),
  };
}

function normalizeTasks(value: unknown): MissionTask[] {
  return asArray<Partial<MissionTask>>(value)
    .filter((task) => task && typeof task.id === 'string' && typeof task.title === 'string')
    .slice(0, MISSION_LIMITS.maxTasks + 2)
    .map((task) => ({
      id: String(task.id),
      title: String(task.title).slice(0, 140),
      brief: typeof task.brief === 'string' ? task.brief.slice(0, 2000) : '',
      agentId: isAgentId(task.agentId) && task.agentId !== 'nova' ? task.agentId : 'relay',
      status: pick(task.status, TASK_STATUSES, 'queued'),
      dependsOn: asArray<unknown>(task.dependsOn)
        .filter((id): id is string => typeof id === 'string')
        .slice(0, 8),
      attempt: typeof task.attempt === 'number' ? Math.max(0, task.attempt) : 0,
      maxAttempts:
        typeof task.maxAttempts === 'number'
          ? Math.min(Math.max(1, task.maxAttempts), MISSION_LIMITS.maxAttempts)
          : MISSION_LIMITS.maxAttempts,
      output: typeof task.output === 'string' ? task.output : undefined,
      error: typeof task.error === 'string' ? task.error : undefined,
      model: typeof task.model === 'string' ? task.model : undefined,
      startedAt: typeof task.startedAt === 'number' ? task.startedAt : undefined,
      finishedAt: typeof task.finishedAt === 'number' ? task.finishedAt : undefined,
      durationMs: typeof task.durationMs === 'number' ? task.durationMs : undefined,
      review:
        task.review && typeof task.review === 'object'
          ? {
              verdict: task.review.verdict === 'retry' ? ('retry' as const) : ('pass' as const),
              notes: typeof task.review.notes === 'string' ? task.review.notes : '',
              model: typeof task.review.model === 'string' ? task.review.model : 'unknown',
              createdAt:
                typeof task.review.createdAt === 'number' ? task.review.createdAt : Date.now(),
            }
          : undefined,
    }))
    .filter((task) => task.title.length > 0);
}

function normalizeBudget(value: unknown): MissionBudget {
  const base = defaultMissionBudget();
  if (!value || typeof value !== 'object') return base;
  const budget = value as Partial<MissionBudget>;

  return {
    maxTasks: MISSION_LIMITS.maxTasks,
    maxCalls: MISSION_LIMITS.maxCalls,
    maxAttempts: MISSION_LIMITS.maxAttempts,
    callsUsed: typeof budget.callsUsed === 'number' ? Math.max(0, budget.callsUsed) : 0,
    startedAt: typeof budget.startedAt === 'number' ? budget.startedAt : base.startedAt,
    deadlineAt: typeof budget.deadlineAt === 'number' ? budget.deadlineAt : 0,
  };
}

function normalizeApproval(value: unknown): MissionApproval | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const approval = value as Partial<MissionApproval>;
  if (typeof approval.id !== 'string') return undefined;

  return {
    id: approval.id,
    kind: approval.kind === 'escalation' ? 'escalation' : 'plan',
    status:
      approval.status === 'approved' || approval.status === 'rejected'
        ? approval.status
        : 'pending',
    note: typeof approval.note === 'string' ? approval.note.slice(0, 400) : '',
    taskId: optionalString(approval.taskId),
    createdAt: typeof approval.createdAt === 'number' ? approval.createdAt : Date.now(),
    resolvedAt: typeof approval.resolvedAt === 'number' ? approval.resolvedAt : undefined,
  };
}

function normalizeReport(value: unknown): MissionReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const report = value as Partial<MissionReport>;
  if (typeof report.text !== 'string' || report.text.trim().length === 0) return undefined;

  return {
    text: report.text,
    model: typeof report.model === 'string' ? report.model : 'unknown',
    createdAt: typeof report.createdAt === 'number' ? report.createdAt : Date.now(),
    completed: typeof report.completed === 'number' ? report.completed : 0,
    failed: typeof report.failed === 'number' ? report.failed : 0,
    callsUsed: typeof report.callsUsed === 'number' ? report.callsUsed : 0,
    durationMs: typeof report.durationMs === 'number' ? report.durationMs : 0,
  };
}

function normalizeHistory(value: unknown): MissionEvent[] {
  return asArray<Partial<MissionEvent>>(value)
    .filter((event) => event && typeof event.label === 'string')
    .map((event) => ({
      id: typeof event.id === 'string' ? event.id : createId('evt'),
      label: String(event.label).slice(0, 140),
      detail: typeof event.detail === 'string' ? event.detail.slice(0, 400) : undefined,
      createdAt: typeof event.createdAt === 'number' ? event.createdAt : Date.now(),
    }))
    .slice(0, 60);
}

/**
 * Missions created before Phase Four have no plan, budget or history. They are
 * normalized into single-agent missions so existing work keeps running.
 */
function normalizeMissions(value: unknown): Mission[] {
  return asArray<Partial<Mission>>(value)
    .filter((mission) => mission && typeof mission.id === 'string' && typeof mission.title === 'string')
    .map((mission) => {
      const kind: MissionKind = mission.kind === 'planned' ? 'planned' : 'single';
      const mode: MissionRunMode = mission.mode === 'review' ? 'review' : 'auto';
      const createdAt = typeof mission.createdAt === 'number' ? mission.createdAt : Date.now();

      return {
        id: String(mission.id),
        title: String(mission.title).slice(0, 160),
        objective: typeof mission.objective === 'string' ? mission.objective : '',
        agentId: isAgentId(mission.agentId) ? mission.agentId : 'nova',
        projectId: optionalString(mission.projectId),
        status: pick(mission.status, MISSION_STATUSES, 'queued'),
        kind,
        mode,
        tasks: normalizeTasks(mission.tasks),
        budget: normalizeBudget(mission.budget),
        approval: normalizeApproval(mission.approval),
        report: normalizeReport(mission.report),
        history: normalizeHistory(mission.history),
        planModel: typeof mission.planModel === 'string' ? mission.planModel : undefined,
        planCreatedAt:
          typeof mission.planCreatedAt === 'number' ? mission.planCreatedAt : undefined,
        createdAt,
        updatedAt: typeof mission.updatedAt === 'number' ? mission.updatedAt : createdAt,
        startedAt: typeof mission.startedAt === 'number' ? mission.startedAt : undefined,
        result: normalizeResult(mission.result),
      };
    });
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
    missions: normalizeMissions(parsed.missions),
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

    const v3 = normalize(await AsyncStorage.getItem(LEGACY_V3_KEY), false);
    if (v3) return v3;

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
    await AsyncStorage.multiRemove([STATE_KEY, LEGACY_V3_KEY, LEGACY_V2_KEY, LEGACY_V1_KEY]);
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

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (KNOWN_AGENT_IDS as string[]).includes(value);
}
