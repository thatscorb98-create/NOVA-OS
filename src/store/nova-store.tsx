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
import {
  clearPersistedState,
  loadPersistedState,
  savePersistedState,
  type PersistedState,
} from '@/lib/storage';
import { NOVA_CORE } from '@/lib/nova-core';
import type {
  ActivityEvent,
  AgentId,
  Message,
  Mission,
  MissionStatus,
  Project,
} from '@/types/nova';

/**
 * Local-first NOVA workspace.
 *
 * Everything the user creates (missions, projects, conversations, activity) is
 * real data persisted on the device. The store is deliberately independent of
 * any AI provider so the model layer can be added without touching screens.
 */

const MAX_ACTIVITY = 80;
const MAX_MESSAGES = 240;

interface NovaState extends PersistedState {}

const initialState: NovaState = {
  missions: [],
  projects: [],
  messages: [],
  activity: [],
};

type Action =
  | { type: 'hydrate'; state: PersistedState }
  | { type: 'createMission'; mission: Mission; event: ActivityEvent }
  | { type: 'setMissionStatus'; id: string; status: MissionStatus; event: ActivityEvent }
  | { type: 'deleteMission'; id: string; event: ActivityEvent }
  | { type: 'createProject'; project: Project; event: ActivityEvent }
  | { type: 'deleteProject'; id: string; event: ActivityEvent }
  | { type: 'appendMessages'; messages: Message[] }
  | { type: 'recordActivity'; event: ActivityEvent }
  | { type: 'reset' };

function withActivity(state: NovaState, event: ActivityEvent): ActivityEvent[] {
  return [event, ...state.activity].slice(0, MAX_ACTIVITY);
}

function reducer(state: NovaState, action: Action): NovaState {
  switch (action.type) {
    case 'hydrate':
      return action.state;

    case 'createMission':
      return {
        ...state,
        missions: [action.mission, ...state.missions],
        activity: withActivity(state, action.event),
      };

    case 'setMissionStatus':
      return {
        ...state,
        missions: state.missions.map((mission) =>
          mission.id === action.id
            ? { ...mission, status: action.status, updatedAt: Date.now() }
            : mission,
        ),
        activity: withActivity(state, action.event),
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
        activity: withActivity(state, action.event),
      };

    case 'appendMessages':
      return {
        ...state,
        messages: [...state.messages, ...action.messages].slice(-MAX_MESSAGES),
      };

    case 'recordActivity':
      return { ...state, activity: withActivity(state, action.event) };

    case 'reset':
      return initialState;

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
  deleteMission: (mission: Mission) => void;
  createProject: (input: CreateProjectInput) => Project;
  deleteProject: (project: Project) => void;
  sendChatMessage: (text: string) => void;
  resetWorkspace: () => Promise<void>;
}

const NovaContext = createContext<NovaContextValue | null>(null);

export function NovaProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
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

  const createMission = useCallback((input: CreateMissionInput) => {
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
      event: {
        id: createId('evt'),
        kind: 'mission',
        label: 'Mission created',
        detail: mission.title,
        createdAt: now,
      },
    });

    return mission;
  }, []);

  const advanceMission = useCallback((mission: Mission) => {
    const nextStatus: MissionStatus =
      mission.status === 'queued' ? 'active' : mission.status === 'active' ? 'complete' : 'queued';

    const label =
      nextStatus === 'active'
        ? 'Mission started'
        : nextStatus === 'complete'
          ? 'Mission completed'
          : 'Mission reopened';

    dispatch({
      type: 'setMissionStatus',
      id: mission.id,
      status: nextStatus,
      event: {
        id: createId('evt'),
        kind: 'mission',
        label,
        detail: mission.title,
        createdAt: Date.now(),
      },
    });
  }, []);

  const deleteMission = useCallback((mission: Mission) => {
    dispatch({
      type: 'deleteMission',
      id: mission.id,
      event: {
        id: createId('evt'),
        kind: 'mission',
        label: 'Mission removed',
        detail: mission.title,
        createdAt: Date.now(),
      },
    });
  }, []);

  const createProject = useCallback((input: CreateProjectInput) => {
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
      event: {
        id: createId('evt'),
        kind: 'project',
        label: 'Project created',
        detail: project.name,
        createdAt: project.createdAt,
      },
    });

    return project;
  }, []);

  const deleteProject = useCallback((project: Project) => {
    dispatch({
      type: 'deleteProject',
      id: project.id,
      event: {
        id: createId('evt'),
        kind: 'project',
        label: 'Project removed',
        detail: project.name,
        createdAt: Date.now(),
      },
    });
  }, []);

  const sendChatMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const now = Date.now();
    const userMessage: Message = {
      id: createId('msg'),
      role: 'user',
      text: trimmed,
      createdAt: now,
    };

    const messages: Message[] = [userMessage];

    // No provider is connected in Phase One, so a transparent system notice is
    // recorded instead of a fabricated answer.
    if (NOVA_CORE.status !== 'connected') {
      messages.push({
        id: createId('msg'),
        role: 'system',
        text: NOVA_CORE.detail,
        createdAt: now + 1,
      });
    }

    dispatch({ type: 'appendMessages', messages });
    dispatch({
      type: 'recordActivity',
      event: {
        id: createId('evt'),
        kind: 'chat',
        label: 'Message sent to NOVA',
        detail: trimmed.length > 70 ? `${trimmed.slice(0, 70)}…` : trimmed,
        createdAt: now,
      },
    });
  }, []);

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
      deleteMission,
      createProject,
      deleteProject,
      sendChatMessage,
      resetWorkspace,
    }),
    [
      state,
      hydrated,
      createMission,
      advanceMission,
      deleteMission,
      createProject,
      deleteProject,
      sendChatMessage,
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
