import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';

import { createId } from '@/lib/id';
import { extractTags, normalizeMemoryText } from '@/lib/memory';
import {
  clearPersistedState,
  emptyState,
  KNOWN_AGENT_IDS,
  loadPersistedState,
  savePersistedState,
  type PersistedState,
} from '@/lib/storage';
import { DEFAULT_MODEL, isKnownModel } from '@/lib/model/models';
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
  MissionResult,
  MissionStatus,
  Project,
} from '@/types/nova';

/**
 * Local-first NOVA workspace.
 *
 * Missions, projects, conversations, persistent memories and model settings are
 * real data persisted on the device. The store never calls a model: that is the
 * job of AgentRuntimeProvider, so the UI and the intelligence layer stay
 * independent.
 */

const MAX_ACTIVITY = 120;
const MAX_MESSAGES = 240;
const MAX_THREAD = 120;
const MAX_MEMORIES = 600;
const MAX_MEMORY_CHARS = 1000;

interface NovaState extends PersistedState {}

function defaultAgents(): Record<string, AgentState> {
  return KNOWN_AGENT_IDS.reduce<Record<string, AgentState>>((acc, id) => {
    acc[id] = { enabled: true };
    return acc;
  }, {});
}

function initialState(): NovaState {
  return {
    ...emptyState(),
    agents: defaultAgents(),
    settings: { model: DEFAULT_MODEL },
  };
}

export interface AddMemoryInput {
  text: string;
  scope: MemoryScope;
  kind?: MemoryKind;
  source?: MemorySource;
  agentId?: AgentId;
  projectId?: string;
  conversationId?: string;
  tags?: string[];
  pinned?: boolean;
}

export type MemoryPatch = Partial<
  Pick<MemoryRecord, 'text' | 'kind' | 'pinned' | 'tags' | 'scope' | 'projectId' | 'agentId'>
>;

type Action =
  | { type: 'hydrate'; state: PersistedState }
  | { type: 'createMission'; mission: Mission; event: ActivityEvent }
  | { type: 'updateMission'; id: string; patch: Partial<Mission>; event?: ActivityEvent }
  | { type: 'deleteMission'; id: string; event: ActivityEvent }
  | { type: 'createProject'; project: Project; event: ActivityEvent }
  | { type: 'deleteProject'; id: string; event: ActivityEvent }
  | { type: 'appendMessages'; messages: Message[] }
  | { type: 'appendThreadMessages'; agentId: AgentId; messages: Message[] }
  | { type: 'clearThread'; agentId: AgentId }
  | { type: 'setAgentEnabled'; agentId: AgentId; enabled: boolean; event: ActivityEvent }
  | { type: 'addMemory'; memory: MemoryRecord }
  | { type: 'touchMemory'; id: string }
  | { type: 'updateMemory'; id: string; patch: MemoryPatch }
  | { type: 'deleteMemory'; id: string }
  | { type: 'setSettings'; settings: Partial<AppSettings> }
  | { type: 'recordActivity'; event: ActivityEvent }
  | { type: 'reset' };

function withActivity(state: NovaState, event: ActivityEvent): ActivityEvent[] {
  return [event, ...state.activity].slice(0, MAX_ACTIVITY);
}

/**
 * Keep the ledger bounded without ever evicting a pinned memory. Conversation
 * summaries are evicted first so the automatic chat log can never push out a
 * fact, preference or decision the owner relies on.
 */
function pruneMemories(memories: MemoryRecord[]): MemoryRecord[] {
  if (memories.length <= MAX_MEMORIES) return memories;

  const pinned = memories.filter((memory) => memory.pinned);
  const capacity = Math.max(0, MAX_MEMORIES - pinned.length);

  const disposable = memories
    .filter((memory) => !memory.pinned)
    .sort((a, b) => {
      const aChat = a.scope === 'conversation' ? 0 : 1;
      const bChat = b.scope === 'conversation' ? 0 : 1;
      return aChat - bChat || a.updatedAt - b.updatedAt;
    });

  const kept = disposable.slice(disposable.length - capacity);

  return [...pinned, ...kept].sort((a, b) => b.updatedAt - a.updatedAt);
}

function reducer(state: NovaState, action: Action): NovaState {
  switch (action.type) {
    case 'hydrate':
      return {
        ...action.state,
        agents: { ...defaultAgents(), ...action.state.agents },
      };

    case 'createMission':
      return {
        ...state,
        missions: [action.mission, ...state.missions],
        activity: withActivity(state, action.event),
      };

    case 'updateMission':
      return {
        ...state,
        missions: state.missions.map((mission) =>
          mission.id === action.id
            ? { ...mission, ...action.patch, updatedAt: Date.now() }
            : mission,
        ),
        activity: action.event ? withActivity(state, action.event) : state.activity,
      };

    case 'deleteMission':
      return {
        ...state,
        missions: state.missions.filter((mission) => mission.id !== action.id),
        activity: withActivity(state, action.event),
      };

    case 'createProject':
      return {
        ...state,
        projects: [action.project, ...state.projects],
        activity: withActivity(state, action.event),
      };

    case 'deleteProject':
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== action.id),
        missions: state.missions.map((mission) =>
          mission.projectId === action.id ? { ...mission, projectId: undefined } : mission,
        ),
        // Project memories are knowledge, not project structure: keep them and
        // promote them to global so nothing is silently lost.
        memories: state.memories.map((memory) =>
          memory.projectId === action.id
            ? {
                ...memory,
                projectId: undefined,
                scope: memory.scope === 'project' ? 'global' : memory.scope,
                updatedAt: Date.now(),
              }
            : memory,
        ),
        activity: withActivity(state, action.event),
      };

    case 'appendMessages':
      return {
        ...state,
        messages: [...state.messages, ...action.messages].slice(-MAX_MESSAGES),
      };

    case 'appendThreadMessages': {
      const existing = state.threads[action.agentId] ?? [];
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.agentId]: [...existing, ...action.messages].slice(-MAX_THREAD),
        },
      };
    }

    case 'clearThread':
      return {
        ...state,
        threads: { ...state.threads, [action.agentId]: [] },
      };

    case 'setAgentEnabled':
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { enabled: action.enabled } },
        activity: withActivity(state, action.event),
      };

    case 'addMemory':
      return {
        ...state,
        memories: pruneMemories([action.memory, ...state.memories]),
      };

    case 'touchMemory':
      return {
        ...state,
        memories: state.memories.map((memory) =>
          memory.id === action.id ? { ...memory, updatedAt: Date.now() } : memory,
        ),
      };

    case 'updateMemory':
      return {
        ...state,
        memories: state.memories.map((memory) => {
          if (memory.id !== action.id) return memory;

          const nextText =
            typeof action.patch.text === 'string' && action.patch.text.trim().length > 0
              ? action.patch.text.trim().slice(0, MAX_MEMORY_CHARS)
              : memory.text;

          return { ...memory, ...action.patch, text: nextText, updatedAt: Date.now() };
        }),
      };

    case 'deleteMemory':
      return {
        ...state,
        memories: state.memories.filter((memory) => memory.id !== action.id),
      };

    case 'setSettings':
      return { ...state, settings: { ...state.settings, ...action.settings } };

    case 'recordActivity':
      return { ...state, activity: withActivity(state, action.event) };

    case 'reset':
      return initialState();

    default:
      return state;
  }
}

export interface CreateMissionInput {
  title: string;
  objective?: string;
  agentId: AgentId;
  projectId?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  accent: string;
}

interface NovaContextValue extends NovaState {
  hydrated: boolean;
  createMission: (input: CreateMissionInput) => Mission;
  advanceMission: (mission: Mission) => void;
  setMissionStatus: (missionId: string, status: MissionStatus) => void;
  setMissionResult: (missionId: string, result: MissionResult) => void;
  deleteMission: (mission: Mission) => void;
  createProject: (input: CreateProjectInput) => Project;
  deleteProject: (project: Project) => void;
  appendMessages: (messages: Message[]) => void;
  appendThreadMessages: (agentId: AgentId, messages: Message[]) => void;
  clearThread: (agentId: AgentId) => void;
  setAgentEnabled: (agentId: AgentId, enabled: boolean) => void;
  addMemory: (input: AddMemoryInput) => MemoryRecord | null;
  updateMemory: (id: string, patch: MemoryPatch) => void;
  deleteMemory: (id: string) => void;
  setMemoryPinned: (id: string, pinned: boolean) => void;
  setModel: (model: string) => void;
  recordActivity: (kind: ActivityEvent['kind'], label: string, detail?: string) => void;
  resetWorkspace: () => Promise<void>;
}

const NovaContext = createContext<NovaContextValue | null>(null);

export function NovaProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const saved = await loadPersistedState();
      if (cancelled) return;
      if (saved) dispatch({ type: 'hydrate', state: saved });
      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void savePersistedState(state);
  }, [state, hydrated]);

  const activity = useCallback(
    (kind: ActivityEvent['kind'], label: string, detail?: string): ActivityEvent => ({
      id: createId('evt'),
      kind,
      label,
      detail,
      createdAt: Date.now(),
    }),
    [],
  );

  const createMission = useCallback(
    (input: CreateMissionInput) => {
      const now = Date.now();
      const mission: Mission = {
        id: createId('msn'),
        title: input.title.trim(),
        objective: input.objective?.trim() ?? '',
        agentId: input.agentId,
        projectId: input.projectId,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };

      dispatch({
        type: 'createMission',
        mission,
        event: activity('mission', 'Mission created', mission.title),
      });

      return mission;
    },
    [activity],
  );

  const advanceMission = useCallback(
    (mission: Mission) => {
      const nextStatus: MissionStatus =
        mission.status === 'queued' ? 'active' : mission.status === 'active' ? 'complete' : 'queued';

      const label =
        nextStatus === 'active'
          ? 'Mission started'
          : nextStatus === 'complete'
            ? 'Mission completed'
            : 'Mission reopened';

      dispatch({
        type: 'updateMission',
        id: mission.id,
        patch: { status: nextStatus },
        event: activity('mission', label, mission.title),
      });
    },
    [activity],
  );

  const setMissionStatus = useCallback((missionId: string, status: MissionStatus) => {
    dispatch({
      type: 'updateMission',
      id: missionId,
      patch: { status, startedAt: status === 'active' ? Date.now() : undefined },
    });
  }, []);

  const setMissionResult = useCallback((missionId: string, result: MissionResult) => {
    dispatch({
      type: 'updateMission',
      id: missionId,
      patch: { status: 'complete', result },
    });
  }, []);

  const deleteMission = useCallback(
    (mission: Mission) => {
      dispatch({
        type: 'deleteMission',
        id: mission.id,
        event: activity('mission', 'Mission removed', mission.title),
      });
    },
    [activity],
  );

  const createProject = useCallback(
    (input: CreateProjectInput) => {
      const project: Project = {
        id: createId('prj'),
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        accent: input.accent,
        createdAt: Date.now(),
      };

      dispatch({
        type: 'createProject',
        project,
        event: activity('project', 'Project created', project.name),
      });

      return project;
    },
    [activity],
  );

  const deleteProject = useCallback(
    (project: Project) => {
      dispatch({
        type: 'deleteProject',
        id: project.id,
        event: activity('project', 'Project removed', project.name),
      });
    },
    [activity],
  );

  const appendMessages = useCallback((messages: Message[]) => {
    dispatch({ type: 'appendMessages', messages });
  }, []);

  const appendThreadMessages = useCallback((agentId: AgentId, messages: Message[]) => {
    dispatch({ type: 'appendThreadMessages', agentId, messages });
  }, []);

  const clearThread = useCallback((agentId: AgentId) => {
    dispatch({ type: 'clearThread', agentId });
  }, []);

  const setAgentEnabled = useCallback(
    (agentId: AgentId, enabled: boolean) => {
      dispatch({
        type: 'setAgentEnabled',
        agentId,
        enabled,
        event: activity('agent', enabled ? 'Agent enabled' : 'Agent disabled', agentId.toUpperCase()),
      });
    },
    [activity],
  );

  const addMemory = useCallback(
    (input: AddMemoryInput): MemoryRecord | null => {
      const text = input.text.trim().slice(0, MAX_MEMORY_CHARS);
      if (!text) return null;

      const normalized = normalizeMemoryText(text);
      const duplicate = state.memories.find(
        (memory) =>
          memory.scope === input.scope &&
          normalizeMemoryText(memory.text) === normalized &&
          (memory.agentId ?? '') === (input.agentId ?? '') &&
          (memory.projectId ?? '') === (input.projectId ?? ''),
      );

      if (duplicate) {
        dispatch({ type: 'touchMemory', id: duplicate.id });
        return duplicate;
      }

      const now = Date.now();
      const record: MemoryRecord = {
        id: createId('mem'),
        text,
        scope: input.scope,
        kind: input.kind ?? 'note',
        source: input.source ?? 'user',
        agentId: input.agentId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        tags: (input.tags && input.tags.length > 0 ? input.tags : extractTags(text)).slice(0, 8),
        pinned: input.pinned ?? false,
        createdAt: now,
        updatedAt: now,
      };

      dispatch({ type: 'addMemory', memory: record });
      return record;
    },
    [state.memories],
  );

  const updateMemory = useCallback((id: string, patch: MemoryPatch) => {
    dispatch({ type: 'updateMemory', id, patch });
  }, []);

  const deleteMemory = useCallback((id: string) => {
    dispatch({ type: 'deleteMemory', id });
  }, []);

  const setMemoryPinned = useCallback((id: string, pinned: boolean) => {
    dispatch({ type: 'updateMemory', id, patch: { pinned } });
  }, []);

  const setModel = useCallback((model: string) => {
    if (!isKnownModel(model)) return;
    dispatch({ type: 'setSettings', settings: { model } });
  }, []);

  const recordActivity = useCallback(
    (kind: ActivityEvent['kind'], label: string, detail?: string) => {
      dispatch({ type: 'recordActivity', event: activity(kind, label, detail) });
    },
    [activity],
  );

  const resetWorkspace = useCallback(async () => {
    dispatch({ type: 'reset' });
    await clearPersistedState();
  }, []);

  const value = useMemo<NovaContextValue>(
    () => ({
      ...state,
      hydrated,
      createMission,
      advanceMission,
      setMissionStatus,
      setMissionResult,
      deleteMission,
      createProject,
      deleteProject,
      appendMessages,
      appendThreadMessages,
      clearThread,
      setAgentEnabled,
      addMemory,
      updateMemory,
      deleteMemory,
      setMemoryPinned,
      setModel,
      recordActivity,
      resetWorkspace,
    }),
    [
      state,
      hydrated,
      createMission,
      advanceMission,
      setMissionStatus,
      setMissionResult,
      deleteMission,
      createProject,
      deleteProject,
      appendMessages,
      appendThreadMessages,
      clearThread,
      setAgentEnabled,
      addMemory,
      updateMemory,
      deleteMemory,
      setMemoryPinned,
      setModel,
      recordActivity,
      resetWorkspace,
    ],
  );

  return <NovaContext.Provider value={value}>{children}</NovaContext.Provider>;
}

export function useNova(): NovaContextValue {
  const context = useContext(NovaContext);
  if (!context) {
    throw new Error('useNova must be used inside <NovaProvider>');
  }
  return context;
}
