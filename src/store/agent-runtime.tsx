import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getAgent, isAgentId } from '@/data/agents';
import { createId } from '@/lib/id';
import {
  chatCompletion,
  describeModelError,
  ModelError,
  type ModelMessage,
  type ModelToolCall,
} from '@/lib/model/client';
import { deleteApiKey, readApiKey, writeApiKey } from '@/lib/model/secure-key';
import { toolDefinitionsFor } from '@/lib/model/tools';
import { useNova } from '@/store/nova-store';
import type {
  Agent,
  AgentId,
  AgentToolId,
  Message,
  Mission,
  MissionResult,
} from '@/types/nova';

/**
 * The intelligence layer.
 *
 * This provider performs real NVIDIA NIM chat completions, executes the tools
 * the model requests against the local workspace, delegates to specialist
 * agents, and persists every result. It never synthesises an agent reply.
 */

const MAX_HISTORY = 14;
const MAX_TOOL_STEPS = 5;

export interface RuntimeResult {
  ok: boolean;
  text?: string;
  error?: string;
  missionId?: string;
}

interface RunOutput {
  text: string;
  steps: string[];
  model: string;
  durationMs: number;
}

interface AssignTaskInput {
  agentId: AgentId;
  title: string;
  objective: string;
}

interface AgentRuntimeValue {
  model: string;
  hasKey: boolean;
  keyLoaded: boolean;
  setModel: (model: string) => void;
  saveKey: (key: string) => Promise<RuntimeResult>;
  removeKey: () => Promise<void>;
  testConnection: () => Promise<RuntimeResult>;
  sendNovaMessage: (text: string) => Promise<RuntimeResult>;
  sendAgentMessage: (agentId: AgentId, text: string) => Promise<RuntimeResult>;
  runMission: (missionId: string) => Promise<RuntimeResult>;
  assignAndRun: (input: AssignTaskInput) => Promise<RuntimeResult>;
  isBusy: (key: string) => boolean;
  clearError: () => void;
  lastError: string | null;
}

const AgentRuntimeContext = createContext<AgentRuntimeValue | null>(null);

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toModelHistory(messages: Message[]): ModelMessage[] {
  return messages
    .filter((message) => message.role !== 'system' && message.text.trim().length > 0)
    .slice(-MAX_HISTORY)
    .map((message) => ({
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.text,
    }));
}

export function AgentRuntimeProvider({ children }: { children: React.ReactNode }) {
  const nova = useNova();
  const novaRef = useRef(nova);
  novaRef.current = nova;

  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyLoaded, setKeyLoaded] = useState(false);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [lastError, setLastError] = useState<string | null>(null);

  const apiKeyRef = useRef<string | null>(null);
  const modelRef = useRef(nova.settings.model);
  modelRef.current = nova.settings.model;

  useEffect(() => {
    let alive = true;

    void readApiKey().then((key) => {
      if (!alive) return;
      apiKeyRef.current = key;
      setApiKey(key);
      setKeyLoaded(true);
    });

    return () => {
      alive = false;
    };
  }, []);

  const markBusy = useCallback((key: string, delta: 1 | -1) => {
    setBusy((previous) => {
      const next = { ...previous };
      const value = Math.max(0, (next[key] ?? 0) + delta);
      if (value === 0) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  const withBusy = useCallback(
    async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
      markBusy(key, 1);
      try {
        return await run();
      } finally {
        markBusy(key, -1);
      }
    },
    [markBusy],
  );

  const engine = useMemo(() => {
    const current = () => novaRef.current;

    function buildSystemPrompt(agent: Agent): string {
      const state = current();
      const projects = state.projects
        .slice(0, 8)
        .map((project) => `- ${project.name}: ${truncate(project.description, 110) || 'no description'}`)
        .join('\n');

      const openMissions = state.missions
        .filter((mission) => mission.status !== 'complete')
        .slice(0, 8)
        .map(
          (mission) =>
            `- ${mission.title} (${getAgent(mission.agentId).name}, ${mission.status})`,
        )
        .join('\n');

      const completed = state.missions
        .filter((mission) => mission.result)
        .slice(0, 5)
        .map((mission) => `- ${mission.title} → ${truncate(mission.result?.text ?? '', 150)}`)
        .join('\n');

      const notes = (state.memory[agent.id]?.notes ?? [])
        .slice(-12)
        .map((note) => `- ${note.text}`)
        .join('\n');

      return [
        agent.systemPrompt,
        `Voice: ${agent.personality}`,
        `Your capabilities: ${agent.capabilities.join(', ')}.`,
        `Today is ${new Date().toISOString().slice(0, 10)}. The owner reads this on an Android phone, so keep answers compact and skip markdown tables.`,
        projects ? `Projects:\n${projects}` : 'No projects exist yet.',
        openMissions ? `Open missions:\n${openMissions}` : 'There are no open missions.',
        completed ? `Recent completed work:\n${completed}` : 'No work has been completed yet.',
        notes ? `Your memory notes:\n${notes}` : 'You have no memory notes yet.',
        'Rules: never invent a tool result or claim an action happened unless a tool returned it. If a request needs live web access, data or execution you do not have, say exactly what is missing.',
      ].join('\n\n');
    }

    function persistResult(mission: Mission, result: MissionResult) {
      const state = current();
      const agent = getAgent(mission.agentId);
      state.setMissionResult(mission.id, result);
      state.addMemoryNote(
        mission.agentId,
        `Completed "${mission.title}": ${truncate(result.text, 220)}`,
        'mission',
      );
      state.appendThreadMessages(mission.agentId, [
        {
          id: createId('msg'),
          role: 'user',
          text: `Mission: ${mission.title}\n\n${mission.objective}`.trim(),
          createdAt: result.createdAt,
        },
        {
          id: createId('msg'),
          role: 'agent',
          agentId: mission.agentId,
          text: result.text,
          createdAt: result.createdAt,
        },
      ]);
      state.recordActivity('mission', `Work delivered by ${agent.name}`, mission.title);
    }

    async function executeMission(mission: Mission): Promise<RuntimeResult> {
      const state = current();
      const agent = getAgent(mission.agentId);

      if (state.agents[agent.id]?.enabled === false) {
        return {
          ok: false,
          error: `${agent.name} is disabled. Enable it on the agent screen before running work.`,
        };
      }

      if (!apiKeyRef.current) {
        return {
          ok: false,
          error: 'The core is offline. Add your NVIDIA API key in Core settings first.',
        };
      }

      const project = mission.projectId
        ? state.projects.find((entry) => entry.id === mission.projectId)
        : undefined;

      const prompt = [
        `Mission: ${mission.title}`,
        mission.objective || 'No further objective was given. Produce the best possible deliverable.',
        project ? `Project: ${project.name} — ${project.description}` : '',
        'Deliver the finished work now. State assumptions explicitly and keep it usable on a phone screen.',
      ]
        .filter(Boolean)
        .join('\n\n');

      state.setMissionStatus(mission.id, 'active');
      state.recordActivity('mission', `Mission started`, `${mission.title} · ${agent.name}`);

      try {
        const run = await executeAgent(
          agent,
          prompt,
          state.threads[agent.id] ?? [],
          agent.tools,
        );

        const result: MissionResult = {
          text: run.text,
          agentId: agent.id,
          model: run.model,
          createdAt: Date.now(),
          durationMs: run.durationMs,
          steps: run.steps,
        };

        persistResult(mission, result);
        return { ok: true, text: run.text, missionId: mission.id };
      } catch (error) {
        const message = describeModelError(error);
        state.recordActivity('mission', 'Mission failed', `${mission.title}: ${message}`);
        return { ok: false, error: message, missionId: mission.id };
      }
    }

    async function executeTool(
      agent: Agent,
      call: ModelToolCall,
      steps: string[],
    ): Promise<string> {
      const state = current();
      const args = parseArguments(call.arguments);

      switch (call.name) {
        case 'save_memory': {
          const note = String(args.note ?? '').trim();
          if (!note) return 'No note was provided, so nothing was saved.';
          state.addMemoryNote(agent.id, note, 'agent');
          steps.push(`Saved to memory: ${truncate(note, 80)}`);
          return 'Saved to your permanent memory.';
        }

        case 'list_workspace': {
          const workspace = {
            missions: state.missions.slice(0, 20).map((mission) => ({
              id: mission.id,
              title: mission.title,
              agent: mission.agentId,
              status: mission.status,
              objective: truncate(mission.objective, 240),
              result: mission.result ? truncate(mission.result.text, 500) : null,
            })),
            projects: state.projects.map((project) => ({
              id: project.id,
              name: project.name,
              description: truncate(project.description, 180),
            })),
            your_memory: (state.memory[agent.id]?.notes ?? []).slice(-10).map((note) => note.text),
          };
          steps.push(`Read the workspace (${state.missions.length} missions)`);
          return JSON.stringify(workspace);
        }

        case 'create_mission': {
          const target = String(args.agent ?? '');
          if (!isAgentId(target) || target === 'nova') {
            return 'Invalid agent. Choose one of atlas, forge, echo, sterling, relay or sentinel.';
          }
          if (state.agents[target]?.enabled === false) {
            return `${target.toUpperCase()} is disabled, so no mission was created.`;
          }
          const mission = state.createMission({
            agentId: target,
            title: String(args.title ?? '').trim() || 'Untitled mission',
            objective: String(args.objective ?? '').trim(),
          });
          steps.push(`Queued "${mission.title}" for ${target.toUpperCase()}`);
          return `Created mission ${mission.id} for ${target.toUpperCase()}. It is queued and has not run yet.`;
        }

        case 'complete_mission': {
          const mission = state.missions.find(
            (entry) => entry.id === String(args.mission_id ?? ''),
          );
          if (!mission) return 'No mission exists with that id. Call list_workspace first.';
          const summary = String(args.summary ?? '').trim();
          state.setMissionResult(mission.id, {
            text: summary || 'Marked complete by NOVA.',
            agentId: agent.id,
            model: modelRef.current,
            createdAt: Date.now(),
            durationMs: 0,
            steps: ['Marked complete through the complete_mission tool'],
          });
          state.recordActivity('mission', 'Mission closed by NOVA', mission.title);
          steps.push(`Closed mission "${mission.title}"`);
          return 'Mission marked complete.';
        }

        case 'delegate_task': {
          const target = String(args.agent ?? '');
          if (!isAgentId(target) || target === 'nova') {
            return 'Invalid specialist. Choose one of atlas, forge, echo, sterling, relay or sentinel.';
          }
          if (state.agents[target]?.enabled === false) {
            return `${target.toUpperCase()} is disabled. Tell the owner to enable that agent instead of pretending the work was done.`;
          }

          const task = String(args.task ?? '').trim();
          if (!task) return 'No task was provided to the specialist.';

          const context = String(args.context ?? '').trim();
          const title = truncate(task.split('\n')[0] ?? task, 70) || 'Delegated task';

          const mission = state.createMission({
            agentId: target,
            title,
            objective: [task, context ? `Context: ${context}` : ''].filter(Boolean).join('\n\n'),
          });

          steps.push(`Delegated to ${target.toUpperCase()}: ${truncate(task, 90)}`);

          const output = await executeMission(mission);

          if (!output.ok) {
            steps.push(`Delegation failed: ${truncate(output.error ?? 'unknown error', 140)}`);
            return `${target.toUpperCase()} failed: ${output.error ?? 'unknown error'}`;
          }

          return `Completed work from ${target.toUpperCase()} (${modelRef.current}):\n\n${output.text ?? ''}`;
        }

        default:
          return `Unknown tool "${call.name}".`;
      }
    }

    async function executeAgent(
      agent: Agent,
      prompt: string,
      history: Message[],
      toolIds: AgentToolId[],
    ): Promise<RunOutput> {
      const key = apiKeyRef.current;
      if (!key) {
        throw new ModelError(
          'The core is offline. Add your NVIDIA API key in Core settings first.',
          'config',
        );
      }

      const startedAt = Date.now();
      const messages: ModelMessage[] = [
        { role: 'system', content: buildSystemPrompt(agent) },
        ...toModelHistory(history),
        { role: 'user', content: prompt },
      ];

      const tools = toolDefinitionsFor(toolIds);
      const steps: string[] = [];
      let text = '';
      let usedModel = modelRef.current;

      for (let iteration = 0; iteration < MAX_TOOL_STEPS; iteration += 1) {
        const lastIteration = iteration === MAX_TOOL_STEPS - 1;

        const completion = await chatCompletion({
          apiKey: key,
          model: modelRef.current,
          messages,
          tools: lastIteration ? [] : tools,
          temperature: agent.temperature,
        });

        usedModel = completion.model || usedModel;

        if (completion.toolCalls.length === 0) {
          text = completion.text.trim();
          break;
        }

        messages.push({
          role: 'assistant',
          content: completion.text || null,
          tool_calls: completion.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        for (const call of completion.toolCalls) {
          let output: string;
          try {
            output = await executeTool(agent, call, steps);
          } catch (error) {
            const message = describeModelError(error);
            steps.push(`${call.name} failed: ${truncate(message, 120)}`);
            output = `Tool error: ${message}`;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        }
      }

      if (!text) {
        text = 'The model returned an empty response. Try rephrasing the task.';
      }

      return {
        text,
        steps,
        model: usedModel,
        durationMs: Date.now() - startedAt,
      };
    }

    return { buildSystemPrompt, executeAgent, executeMission };
  }, []);

  const saveKey = useCallback(async (key: string): Promise<RuntimeResult> => {
    try {
      await writeApiKey(key);
      const stored = await readApiKey();
      apiKeyRef.current = stored;
      setApiKey(stored);
      setLastError(null);
      return { ok: true };
    } catch (error) {
      const message = describeModelError(error);
      setLastError(message);
      return { ok: false, error: message };
    }
  }, []);

  const removeKey = useCallback(async () => {
    await deleteApiKey();
    apiKeyRef.current = null;
    setApiKey(null);
    setLastError(null);
  }, []);

  const testConnection = useCallback(async (): Promise<RuntimeResult> => {
    if (!apiKeyRef.current) {
      return { ok: false, error: 'No API key is stored yet. Paste your key and save it first.' };
    }

    return withBusy('test', async () => {
      try {
        const completion = await chatCompletion({
          apiKey: apiKeyRef.current as string,
          model: modelRef.current,
          messages: [
            { role: 'system', content: 'You verify API connectivity. Answer exactly as instructed.' },
            { role: 'user', content: 'Reply with exactly: NOVA CORE ONLINE' },
          ],
          maxTokens: 24,
          temperature: 0,
        });

        return { ok: true, text: completion.text.trim() || '(empty response)' };
      } catch (error) {
        const message = describeModelError(error);
        setLastError(message);
        return { ok: false, error: message };
      }
    });
  }, [withBusy]);

  const sendNovaMessage = useCallback(
    (text: string): Promise<RuntimeResult> =>
      withBusy('nova', async () => {
        const state = novaRef.current;
        const trimmed = text.trim();
        if (!trimmed) return { ok: false };

        const history = state.messages;
        state.appendMessages([
          { id: createId('msg'), role: 'user', text: trimmed, createdAt: Date.now() },
        ]);

        if (!apiKeyRef.current) {
          const message = 'Core offline. Add your NVIDIA API key in Core settings to reach NOVA.';
          state.appendMessages([
            { id: createId('msg'), role: 'system', text: message, createdAt: Date.now() },
          ]);
          setLastError(message);
          return { ok: false, error: message };
        }

        const agent = getAgent('nova');

        try {
          const run = await engine.executeAgent(agent, trimmed, history, agent.tools);
          state.appendMessages([
            { id: createId('msg'), role: 'nova', text: run.text, createdAt: Date.now() },
          ]);
          if (run.steps.length > 0) {
            state.recordActivity('agent', 'NOVA used tools', truncate(run.steps.join(' · '), 300));
          }
          setLastError(null);
          return { ok: true, text: run.text };
        } catch (error) {
          const message = describeModelError(error);
          state.appendMessages([
            { id: createId('msg'), role: 'system', text: message, createdAt: Date.now() },
          ]);
          state.recordActivity('system', 'Model call failed', message);
          setLastError(message);
          return { ok: false, error: message };
        }
      }),
    [engine, withBusy],
  );

  const sendAgentMessage = useCallback(
    (agentId: AgentId, text: string): Promise<RuntimeResult> =>
      withBusy(`agent:${agentId}`, async () => {
        const state = novaRef.current;
        const agent = getAgent(agentId);
        const trimmed = text.trim();
        if (!trimmed) return { ok: false };

        if (state.agents[agentId]?.enabled === false) {
          return { ok: false, error: `${agent.name} is disabled.` };
        }

        const history = state.threads[agentId] ?? [];
        state.appendThreadMessages(agentId, [
          { id: createId('msg'), role: 'user', text: trimmed, createdAt: Date.now() },
        ]);

        if (!apiKeyRef.current) {
          const message = 'Core offline. Add your NVIDIA API key in Core settings first.';
          state.appendThreadMessages(agentId, [
            { id: createId('msg'), role: 'system', text: message, createdAt: Date.now() },
          ]);
          setLastError(message);
          return { ok: false, error: message };
        }

        try {
          const run = await engine.executeAgent(agent, trimmed, history, agent.tools);
          state.appendThreadMessages(agentId, [
            {
              id: createId('msg'),
              role: 'agent',
              agentId,
              text: run.text,
              createdAt: Date.now(),
            },
          ]);
          if (run.steps.length > 0) {
            state.recordActivity('agent', `${agent.name} used tools`, truncate(run.steps.join(' · '), 300));
          }
          setLastError(null);
          return { ok: true, text: run.text };
        } catch (error) {
          const message = describeModelError(error);
          state.appendThreadMessages(agentId, [
            { id: createId('msg'), role: 'system', text: message, createdAt: Date.now() },
          ]);
          state.recordActivity('system', 'Model call failed', `${agent.name}: ${message}`);
          setLastError(message);
          return { ok: false, error: message };
        }
      }),
    [engine, withBusy],
  );

  const runMission = useCallback(
    (missionId: string): Promise<RuntimeResult> =>
      withBusy(`mission:${missionId}`, async () => {
        const mission = novaRef.current.missions.find((entry) => entry.id === missionId);

        if (!mission) {
          return { ok: false, error: 'That mission no longer exists.' };
        }

        return engine.executeMission(mission);
      }),
    [engine, withBusy],
  );

  const assignAndRun = useCallback(
    (input: AssignTaskInput): Promise<RuntimeResult> =>
      withBusy(`agent:${input.agentId}`, async () => {
        const state = novaRef.current;
        const agent = getAgent(input.agentId);

        if (state.agents[input.agentId]?.enabled === false) {
          return { ok: false, error: `${agent.name} is disabled. Enable it first.` };
        }

        if (!input.title.trim()) {
          return { ok: false, error: 'Give the task a short title.' };
        }

        const mission = state.createMission(input);
        const result = await engine.executeMission(mission);
        return { ...result, missionId: mission.id };
      }),
    [engine, withBusy],
  );

  const setModel = useCallback((model: string) => {
    novaRef.current.setModel(model);
  }, []);

  const isBusy = useCallback((key: string) => (busy[key] ?? 0) > 0, [busy]);
  const clearError = useCallback(() => setLastError(null), []);

  const value = useMemo<AgentRuntimeValue>(
    () => ({
      model: nova.settings.model,
      hasKey: Boolean(apiKey),
      keyLoaded,
      setModel,
      saveKey,
      removeKey,
      testConnection,
      sendNovaMessage,
      sendAgentMessage,
      runMission,
      assignAndRun,
      isBusy,
      clearError,
      lastError,
    }),
    [
      nova.settings.model,
      apiKey,
      keyLoaded,
      setModel,
      saveKey,
      removeKey,
      testConnection,
      sendNovaMessage,
      sendAgentMessage,
      runMission,
      assignAndRun,
      isBusy,
      clearError,
      lastError,
    ],
  );

  return (
    <AgentRuntimeContext.Provider value={value}>{children}</AgentRuntimeContext.Provider>
  );
}

export function useAgentRuntime(): AgentRuntimeValue {
  const context = useContext(AgentRuntimeContext);
  if (!context) {
    throw new Error('useAgentRuntime must be used inside <AgentRuntimeProvider>');
  }
  return context;
}
