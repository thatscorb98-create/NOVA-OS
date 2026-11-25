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
import { extractTags, formatMemoriesForPrompt, recallMemories } from '@/lib/memory';
import {
  MISSION_LIMITS,
  nextRunnableTask,
  parseMissionPlan,
  parseMissionReview,
  strandedTasks,
} from '@/lib/mission';
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
  MissionApproval,
  MissionBudget,
  MissionResult,
  MissionStatus,
  MissionTask,
  Project,
} from '@/types/nova';

/**
 * The intelligence layer.
 *
 * This provider performs real NVIDIA NIM chat completions, executes the tools
 * the model requests against the local workspace, plans missions, delegates the
 * planned tasks, reviews the output, retries failures and writes a final report.
 * It never synthesises an agent reply.
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
  approveMission: (missionId: string) => Promise<RuntimeResult>;
  rejectMission: (missionId: string) => Promise<RuntimeResult>;
  retryMissionTask: (missionId: string, taskId: string) => Promise<RuntimeResult>;
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

function replaceTask(tasks: MissionTask[], next: MissionTask): MissionTask[] {
  return tasks.map((task) => (task.id === next.id ? next : task));
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

    function buildSystemPrompt(agent: Agent, query = '', projectId?: string): string {
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

      const recalled = recallMemories({
        memories: state.memories,
        query,
        agentId: agent.id,
        projectId,
        limit: 10,
      });

      const pinned = state.memories.filter((memory) => memory.pinned).slice(0, 6);

      const seen = new Set<string>();
      const mergedMemory = [...pinned, ...recalled].filter((memory) => {
        if (seen.has(memory.id)) return false;
        seen.add(memory.id);
        return true;
      });

      const notes = formatMemoriesForPrompt(mergedMemory, state.projects);

      return [
        agent.systemPrompt,
        `Voice: ${agent.personality}`,
        `Your capabilities: ${agent.capabilities.join(', ')}.`,
        `Today is ${new Date().toISOString().slice(0, 10)}. The owner reads this on an Android phone, so keep answers compact and skip markdown tables.`,
        projects ? `Projects:\n${projects}` : 'No projects exist yet.',
        openMissions ? `Open missions:\n${openMissions}` : 'There are no open missions.',
        completed ? `Recent completed work:\n${completed}` : 'No work has been completed yet.',
        notes
          ? `Your persistent memory, recalled for this turn:\n${notes}\nUse it when relevant; do not recite it unless asked.`
          : 'Your persistent memory is empty. Save durable facts with save_memory.',
        'Rules: never invent a tool result or claim an action happened unless a tool returned it. If the owner refers to earlier work, preferences or previous conversations, call recall_memory before answering. If a request needs live web access, data or execution you do not have, say exactly what is missing.',
      ].join('\n\n');
    }

    function persistResult(mission: Mission, result: MissionResult) {
      const state = current();
      const agent = getAgent(mission.agentId);
      state.setMissionResult(mission.id, result);

      state.addMemory({
        text: `Mission "${mission.title}" delivered by ${agent.name}: ${truncate(result.text, 400)}`,
        scope: 'agent',
        kind: 'note',
        source: 'mission',
        agentId: mission.agentId,
        tags: extractTags(`${mission.title} ${mission.objective}`),
      });

      if (mission.projectId) {
        state.addMemory({
          text: `Project work — "${mission.title}" (${agent.name}): ${truncate(result.text, 400)}`,
          scope: 'project',
          kind: 'note',
          source: 'mission',
          projectId: mission.projectId,
          tags: extractTags(`${mission.title} ${mission.objective}`),
        });
      }

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
          mission.projectId,
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

          const requestedScope = String(args.scope ?? 'agent');
          const scope =
            requestedScope === 'global' || requestedScope === 'project' ? requestedScope : 'agent';
          const requestedKind = String(args.kind ?? 'fact');
          const kind =
            requestedKind === 'preference' ||
            requestedKind === 'decision' ||
            requestedKind === 'note'
              ? requestedKind
              : 'fact';

          const projectId = scope === 'project' ? String(args.project_id ?? '') : undefined;

          if (scope === 'project' && !state.projects.some((entry) => entry.id === projectId)) {
            return 'No project matches that project_id. Call list_workspace for the real project ids.';
          }

          const tags = Array.isArray(args.tags)
            ? args.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
            : extractTags(note);

          const saved = state.addMemory({
            text: note,
            scope,
            kind,
            source: 'agent',
            agentId: scope === 'agent' ? agent.id : undefined,
            projectId,
            tags,
          });

          if (!saved) return 'The note was empty, so nothing was saved.';

          steps.push(`Saved ${scope} memory: ${truncate(note, 80)}`);
          return `Saved memory ${saved.id} in ${scope} scope. It is now in the owner’s memory ledger and can be recalled later.`;
        }

        case 'recall_memory': {
          const query = String(args.query ?? '').trim();
          if (!query) return 'Give recall_memory a topic to search for.';

          const requestedScope = String(args.scope ?? 'all');
          const validScope =
            requestedScope === 'global' ||
            requestedScope === 'project' ||
            requestedScope === 'agent' ||
            requestedScope === 'conversation';

          const pool = validScope
            ? state.memories.filter((memory) => memory.scope === requestedScope)
            : state.memories;

          const results = recallMemories({
            memories: pool,
            query,
            agentId: agent.id,
            limit: 8,
            minScore: 1,
          });

          steps.push(`Recalled ${results.length} memories for "${truncate(query, 60)}"`);

          if (results.length === 0) {
            return `No memories matched "${query}". Tell the owner you have nothing saved on that instead of guessing.`;
          }

          return JSON.stringify({
            query,
            memories: results.map((memory) => ({
              id: memory.id,
              text: memory.text,
              scope: memory.scope,
              kind: memory.kind,
              project_id: memory.projectId ?? null,
              updated_at: memory.updatedAt,
            })),
          });
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
            your_memory: recallMemories({
              memories: state.memories,
              query: '',
              agentId: agent.id,
              limit: 12,
            }).map((memory) => ({
              id: memory.id,
              text: memory.text,
              scope: memory.scope,
            })),
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
      projectId?: string,
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
        { role: 'system', content: buildSystemPrompt(agent, prompt, projectId) },
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

    /**
     * Conversation memory: every substantive exchange is written to the ledger so
     * it can be recalled in a later session. No extra model call, no invention —
     * the record contains the real question and the real answer.
     */
    function rememberExchange(agentId: AgentId, question: string, answer: string) {
      const state = current();
      const trimmed = question.trim();
      if (trimmed.length < 8 || answer.trim().length === 0) return;

      state.addMemory({
        text: `Conversation with ${getAgent(agentId).name} — owner asked: "${truncate(trimmed, 180)}" · answer: "${truncate(answer, 320)}"`,
        scope: 'conversation',
        kind: 'summary',
        source: 'conversation',
        agentId,
        conversationId: `${agentId}-${new Date().toISOString().slice(0, 10)}`,
        tags: extractTags(trimmed),
      });
    }

    function plannerPrompt(project?: Project): string {
      const state = current();
      const recalled = recallMemories({
        memories: state.memories,
        query: 'mission planning constraints preferences decisions',
        agentId: 'nova',
        projectId: project?.id,
        limit: 8,
      });
      const notes = formatMemoriesForPrompt(recalled, state.projects);

      return [
        getAgent('nova').systemPrompt,
        'You are planning a mission that a small team of specialist agents will execute one task at a time. You do not execute anything yourself in this step.',
        `Available specialists: atlas (research and analysis), forge (engineering), echo (marketing and content), sterling (business strategy and finance), relay (operations and sequencing), sentinel (quality, risk and review).`,
        `Return ONLY valid JSON, no prose and no code fences, in exactly this shape:\n{"tasks":[{"title":"short action","brief":"complete self-contained instructions with deliverable and constraints","agent":"atlas","depends_on":[]}]}`,
        `Rules: 1 to ${MISSION_LIMITS.maxTasks} tasks. Use only the six specialist ids above, never nova. Dependencies are zero-based indexes of earlier tasks in the same array. Every brief must stand alone, name the deliverable, and be small enough for one focused response. The last task must produce the outcome the owner asked for. Do not plan work that already exists in the workspace.`,
        project ? `Linked project: ${project.name} — ${project.description}` : '',
        notes ? `Owner memory that constrains this plan:\n${notes}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    function taskPrompt(mission: Mission, task: MissionTask, tasks: MissionTask[]): string {
      const state = current();
      const project = mission.projectId
        ? state.projects.find((entry) => entry.id === mission.projectId)
        : undefined;
      const index = tasks.findIndex((entry) => entry.id === task.id) + 1;

      const prior = tasks
        .filter((entry) => entry.status === 'complete' && entry.output)
        .map((entry) => `- ${entry.title} (${getAgent(entry.agentId).name}): ${truncate(entry.output ?? '', 320)}`)
        .join('\n');

      return [
        `Mission goal: ${mission.title}`,
        mission.objective ? `Owner brief: ${mission.objective}` : '',
        project ? `Project: ${project.name} — ${project.description}` : '',
        `Your task ${index} of ${tasks.length}: ${task.title}`,
        `Task brief: ${task.brief}`,
        prior ? `Finished work from earlier tasks:\n${prior}` : '',
        `You are ${getAgent(task.agentId).name}. Produce the finished deliverable for this task now. Do not describe what you would do; do the work. State assumptions briefly and keep the output readable on a phone.`,
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    function reviewPrompt(task: MissionTask): { system: string; user: string } {
      return {
        system: [
          getAgent('sentinel').systemPrompt,
          'You are reviewing one completed task inside an automated mission. Be strict but practical: the owner is paying for usable output, not perfection.',
          'Return ONLY JSON: {"verdict":"pass","notes":"one or two sentences naming the strongest point and the specific fix if any"}',
          'Use verdict "retry" only when the output is incomplete, ignores the brief, contains placeholders, or asserts facts it cannot support. Otherwise pass it.',
        ].join('\n\n'),
        user: [
          `Task: ${task.title}`,
          `Brief: ${task.brief}`,
          `Attempt: ${task.attempt} of ${task.maxAttempts}`,
          `Output:\n${task.output ?? '(no output)'}`,
        ].join('\n\n'),
      };
    }

    function reportPrompt(mission: Mission, tasks: MissionTask[]): { system: string; user: string } {
      const digest = tasks
        .map((task) => {
          const agent = getAgent(task.agentId);
          return [
            `## ${task.title} — ${agent.name} — ${task.status.toUpperCase()}`,
            task.review?.notes ? `Review: ${task.review.notes}` : '',
            task.error ? `Error: ${task.error}` : '',
            `Result: ${truncate(task.output ?? '(no output produced)', 900)}`,
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n');

      return {
        system: [
          getAgent('nova').systemPrompt,
          'You are writing the final report for a finished mission. The owner reads it on a phone.',
          'Use only the task results below. Never claim work that did not complete. Be concrete and compact.',
          'Format as plain text with these four short sections: OUTCOME (2-4 sentences), DELIVERED (one line per completed task), ISSUES (failed or unverified work, or "None"), NEXT (at most three actions).',
        ].join('\n\n'),
        user: [
          `Mission: ${mission.title}`,
          mission.objective ? `Goal: ${mission.objective}` : '',
          `Tasks planned: ${tasks.length}`,
          digest,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    }

    /**
     * Full planned-mission run: plan, delegate each ready task, review it, retry
     * within the attempt limit, pause for approval where needed, then report.
     *
     * Every model call is counted against mission.budget.callsUsed and the loop
     * is bounded by MISSION_LIMITS.maxSteps, so a mission can never run forever.
     */
    async function runPlannedMission(
      missionId: string,
      afterApproval = false,
    ): Promise<RuntimeResult> {
      const state = current();
      const found = state.missions.find((entry) => entry.id === missionId);

      if (!found) return { ok: false, error: 'That mission no longer exists.' };

      let mission: Mission = found;
      if (!apiKeyRef.current) {
        return {
          ok: false,
          error: 'The core is offline. Add your NVIDIA API key in Core settings first.',
        };
      }
      if (mission.status === 'cancelled') {
        return { ok: false, error: 'This mission was cancelled. Create a new one to continue.' };
      }

      const budget: MissionBudget = {
        ...mission.budget,
        maxTasks: MISSION_LIMITS.maxTasks,
        maxCalls: MISSION_LIMITS.maxCalls,
        maxAttempts: MISSION_LIMITS.maxAttempts,
      };

      const save = (patch: Partial<Mission>) => {
        mission = { ...mission, ...patch, updatedAt: Date.now() } as Mission;
        state.patchMission(missionId, { ...patch, updatedAt: mission.updatedAt });
      };

      const log = (label: string, detail?: string) => {
        save({
          history: [
            { id: createId('evt'), label, detail, createdAt: Date.now() },
            ...(mission?.history ?? []),
          ].slice(0, 60),
        });
      };

      const useCall = () => {
        if (budget.callsUsed >= budget.maxCalls) {
          throw new ModelError(
            `Mission call budget reached (${budget.maxCalls} model requests). Start a new mission for more work.`,
            'config',
          );
        }
        budget.callsUsed += 1;
        save({ budget: { ...budget } });
      };

      if (afterApproval) {
        if (mission.approval?.status === 'pending') {
          save({ approval: { ...mission.approval, status: 'approved', resolvedAt: Date.now() } });
        }
        if (mission.status === 'awaiting_approval') save({ status: 'active' });
      }

      if (mission.approval?.status === 'pending') {
        return { ok: true, text: 'This mission is waiting for your approval.', missionId };
      }

      if (!budget.deadlineAt || budget.deadlineAt < Date.now()) {
        budget.deadlineAt = Date.now() + MISSION_LIMITS.runWindowMs;
        save({ budget: { ...budget } });
      }

      /* ---------------------------------------------------------------- plan */

      if (mission.kind === 'planned' && mission.tasks.length === 0) {
        save({ status: 'planning', startedAt: Date.now() });
        log('Planning started', 'NOVA is decomposing the goal');

        const project = mission.projectId
          ? state.projects.find((entry) => entry.id === mission.projectId)
          : undefined;

        let planText = '';
        let planModel = modelRef.current;

        try {
          useCall();
          const completion = await chatCompletion({
            apiKey: apiKeyRef.current as string,
            model: modelRef.current,
            messages: [
              { role: 'system', content: plannerPrompt(project) },
              {
                role: 'user',
                content: [
                  `Goal: ${mission.title}`,
                  mission.objective ? `Owner brief: ${mission.objective}` : 'No extra brief was given.',
                  `Produce the plan JSON now. Maximum ${MISSION_LIMITS.maxTasks} tasks.`,
                ].join('\n\n'),
              },
            ],
            temperature: 0.2,
            maxTokens: 900,
          });
          planText = completion.text;
          planModel = completion.model || planModel;
        } catch (error) {
          const message = describeModelError(error);
          save({ status: 'queued' });
          log('Planning failed', message);
          state.recordActivity('mission', 'Planning failed', `${mission.title}: ${message}`);
          return { ok: false, error: message, missionId };
        }

        const parsed = parseMissionPlan(planText);

        if (!parsed.ok) {
          save({ status: 'queued' });
          log('Plan rejected', parsed.error);
          return { ok: false, error: parsed.error, missionId };
        }

        const ids = parsed.tasks.map(() => createId('tsk'));
        const tasks: MissionTask[] = parsed.tasks.map((draft, index) => ({
          id: ids[index],
          title: draft.title,
          brief: draft.brief,
          agentId: draft.agentId,
          status: 'queued',
          dependsOn: draft.dependsOnIndexes
            .map((dependencyIndex) => ids[dependencyIndex])
            .filter((value): value is string => typeof value === 'string'),
          attempt: 0,
          maxAttempts: budget.maxAttempts,
        }));

        const needsApproval = mission.mode === 'review';
        const approval: MissionApproval | undefined = needsApproval
          ? {
              id: createId('apr'),
              kind: 'plan',
              status: 'pending',
              note: `${tasks.length} task${tasks.length === 1 ? '' : 's'} planned. Approve to start execution.`,
              createdAt: Date.now(),
            }
          : undefined;

        save({
          tasks,
          planModel,
          planCreatedAt: Date.now(),
          status: needsApproval ? 'awaiting_approval' : 'active',
          approval,
        });
        log(
          `Plan ready · ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
          parsed.trimmed ? `Trimmed to the ${MISSION_LIMITS.maxTasks} task limit.` : undefined,
        );
        state.recordActivity(
          'mission',
          needsApproval ? 'Plan awaiting approval' : 'Plan ready',
          `${mission.title} · ${tasks.length} tasks`,
        );

        if (needsApproval) {
          return { ok: true, text: 'Plan ready for your approval.', missionId };
        }
      }

      if (mission.tasks.length === 0) {
        return { ok: false, error: 'This mission has no plan to execute.', missionId };
      }

      /* ------------------------------------------------------------- execute */

      let tasks = mission.tasks;
      let paused = false;

      const updateTask = (next: MissionTask) => {
        tasks = replaceTask(tasks, next);
        save({ tasks });
      };

      const pauseForApproval = (label: string, note: string, taskId?: string) => {
        const approval: MissionApproval = {
          id: createId('apr'),
          kind: 'escalation',
          status: 'pending',
          note,
          taskId,
          createdAt: Date.now(),
        };
        save({ status: 'awaiting_approval', approval });
        log(label, note);
        state.recordActivity('mission', label, mission.title);
      };

      for (let step = 0; step < MISSION_LIMITS.maxSteps; step += 1) {
        if (current().missions.find((entry) => entry.id === missionId)?.status === 'cancelled') {
          return { ok: false, error: 'Mission cancelled.', missionId };
        }

        if (Date.now() > budget.deadlineAt) {
          pauseForApproval(
            'Run window ended',
            `The ${Math.round(MISSION_LIMITS.runWindowMs / 60_000)} minute window ended. Approve to continue with the remaining call budget.`,
          );
          paused = true;
          break;
        }

        if (budget.callsUsed >= budget.maxCalls) {
          save({ status: 'failed' });
          log(
            'Call budget exhausted',
            `Stopped after ${budget.callsUsed} model requests (hard limit ${MISSION_LIMITS.maxCalls}).`,
          );
          state.recordActivity('mission', 'Call budget exhausted', mission.title);
          return {
            ok: false,
            error: `Mission stopped at the ${MISSION_LIMITS.maxCalls} call limit.`,
            missionId,
          };
        }

        const next = nextRunnableTask(tasks);
        if (!next) break;

        let task: MissionTask = {
          ...next,
          status: 'running',
          attempt: next.attempt + 1,
          startedAt: Date.now(),
          error: undefined,
        };
        updateTask(task);
        save({ status: 'active' });
        log(
          `Running: ${task.title}`,
          `${getAgent(task.agentId).name} · attempt ${task.attempt}/${task.maxAttempts}`,
        );

        let output = '';
        let model = modelRef.current;
        let failure: string | null = null;

        try {
          useCall();
          const agent = getAgent(task.agentId);
          const completion = await chatCompletion({
            apiKey: apiKeyRef.current as string,
            model: modelRef.current,
            messages: [
              {
                role: 'system',
                content: buildSystemPrompt(
                  agent,
                  `${mission.title} ${task.title}`,
                  mission.projectId,
                ),
              },
              { role: 'user', content: taskPrompt(mission, task, tasks) },
            ],
            temperature: agent.temperature,
            maxTokens: 1300,
          });
          output = completion.text.trim();
          model = completion.model || model;
          if (!output) failure = 'The agent returned an empty response.';
        } catch (error) {
          failure = describeModelError(error);
        }

        if (failure) {
          const exhausted = task.attempt >= task.maxAttempts;
          const finishedAt = Date.now();
          task = {
            ...task,
            status: exhausted ? 'blocked' : 'queued',
            error: failure,
            output: output || undefined,
            model,
            finishedAt,
            durationMs: finishedAt - (task.startedAt ?? finishedAt),
          };
          updateTask(task);

          if (exhausted) {
            pauseForApproval(
              'Task failed',
              `${getAgent(task.agentId).name} could not finish "${task.title}" after ${task.attempt} attempt(s): ${failure}`,
              task.id,
            );
            paused = true;
            break;
          }

          log(`Retrying: ${task.title}`, failure);
          continue;
        }

        /* ---------------------------------------------------------- review */

        task = { ...task, status: 'review', output, model };
        updateTask(task);
        save({ status: 'reviewing' });
        log(`Reviewing: ${task.title}`, 'SENTINEL is checking the output against the brief');

        let verdict = { verdict: 'pass' as 'pass' | 'retry', notes: 'Meets the brief.' };

        try {
          useCall();
          const review = reviewPrompt(task);
          const completion = await chatCompletion({
            apiKey: apiKeyRef.current as string,
            model: modelRef.current,
            messages: [
              { role: 'system', content: review.system },
              { role: 'user', content: review.user },
            ],
            temperature: 0.1,
            maxTokens: 320,
          });
          verdict = parseMissionReview(completion.text);
        } catch (error) {
          verdict = {
            verdict: 'pass',
            notes: `Review skipped: ${truncate(describeModelError(error), 160)}`,
          };
        }

        const finishedAt = Date.now();
        const reviewRecord = {
          verdict: verdict.verdict,
          notes: verdict.notes,
          model: modelRef.current,
          createdAt: finishedAt,
        };

        if (verdict.verdict === 'pass') {
          task = {
            ...task,
            status: 'complete',
            review: reviewRecord,
            error: undefined,
            finishedAt,
            durationMs: finishedAt - (task.startedAt ?? finishedAt),
          };
          updateTask(task);
          log(`Task complete: ${task.title}`, verdict.notes);
          continue;
        }

        if (task.attempt < task.maxAttempts) {
          task = {
            ...task,
            status: 'queued',
            review: reviewRecord,
            error: 'Review requested a revision.',
            brief: `${task.brief}\n\nReviewer requested changes: ${verdict.notes}`,
            finishedAt,
            durationMs: finishedAt - (task.startedAt ?? finishedAt),
          };
          updateTask(task);
          log(`Revision requested: ${task.title}`, verdict.notes);
          continue;
        }

        task = {
          ...task,
          status: 'blocked',
          review: reviewRecord,
          error: `Review failed after ${task.maxAttempts} attempt(s): ${verdict.notes}`,
          finishedAt,
          durationMs: finishedAt - (task.startedAt ?? finishedAt),
        };
        updateTask(task);
        pauseForApproval(
          'Task blocked by review',
          `"${task.title}" did not pass review after ${task.maxAttempts} attempt(s). Retry it, accept the failure, or cancel.`,
          task.id,
        );
        paused = true;
        break;
      }

      /* ------------------------------------------------------ dependency sweep */

      const stranded = strandedTasks(tasks);
      if (stranded.length > 0) {
        const strandedIds = new Set(stranded.map((task) => task.id));
        tasks = tasks.map((task) =>
          strandedIds.has(task.id)
            ? { ...task, status: 'failed' as const, error: 'A dependency did not complete.' }
            : task,
        );
        save({ tasks });
        log('Dependency blocked', `${stranded.length} task(s) could not run`);
      }

      if (paused) {
        return { ok: true, text: 'Paused for your approval.', missionId };
      }

      if (current().missions.find((entry) => entry.id === missionId)?.approval?.status === 'pending') {
        return { ok: true, text: 'Waiting for your approval.', missionId };
      }

      const completed = tasks.filter((task) => task.status === 'complete');
      const failedTasks = tasks.filter(
        (task) => task.status === 'failed' || task.status === 'blocked',
      );

      if (completed.length === 0) {
        save({ status: 'failed' });
        log('Mission failed', 'No task produced a deliverable.');
        state.recordActivity('mission', 'Mission failed', mission.title);
        return {
          ok: false,
          error: 'No task produced a deliverable. Check the review notes, then retry a task.',
          missionId,
        };
      }

      /* -------------------------------------------------------------- report */

      save({ status: 'reviewing' });
      log(
        'Writing final report',
        `${completed.length} complete · ${failedTasks.length} failed · ${budget.callsUsed} calls`,
      );

      const { system, user } = reportPrompt(mission, tasks);
      let reportText = '';
      let reportModel = modelRef.current;

      try {
        useCall();
        const completion = await chatCompletion({
          apiKey: apiKeyRef.current as string,
          model: modelRef.current,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
          maxTokens: 900,
        });
        reportText = completion.text.trim();
        reportModel = completion.model || reportModel;
      } catch (error) {
        reportText = [
          'A model-written report was not produced.',
          describeModelError(error),
          '',
          'DELIVERED',
          ...completed.map((task) => `- ${task.title}: ${truncate(task.output ?? '', 240)}`),
          '',
          'ISSUES',
          failedTasks.length === 0
            ? 'None'
            : failedTasks.map((task) => `- ${task.title}: ${task.error ?? 'failed'}`).join('\n'),
        ].join('\n');
        reportModel = 'system';
      }

      const now = Date.now();
      const durationMs = now - budget.startedAt;
      const status: MissionStatus = failedTasks.length > 0 ? 'failed' : 'complete';
      const summary = `Mission "${mission.title}" ${status === 'complete' ? 'completed' : 'finished with issues'} — ${completed.length}/${tasks.length} tasks delivered.`;

      save({
        status,
        report: {
          text: reportText,
          model: reportModel,
          createdAt: now,
          completed: completed.length,
          failed: failedTasks.length,
          callsUsed: budget.callsUsed,
          durationMs,
        },
        result: {
          text: reportText,
          agentId: 'nova',
          model: reportModel,
          createdAt: now,
          durationMs,
          steps: tasks.map(
            (task) =>
              `${getAgent(task.agentId).name} · ${task.title} · ${task.status.toUpperCase()}${
                task.review ? ` · review ${task.review.verdict}` : ''
              }`,
          ),
        },
      });
      log('Mission finished', `${completed.length}/${tasks.length} tasks delivered`);
      state.recordActivity(
        'mission',
        status === 'complete' ? 'Mission completed' : 'Mission finished with issues',
        summary,
      );

      state.addMemory({
        text: `${summary} ${truncate(reportText, 400)}`,
        scope: 'agent',
        kind: 'summary',
        source: 'mission',
        agentId: 'nova',
        projectId: mission.projectId,
        tags: extractTags(`${mission.title} ${mission.objective}`),
      });

      if (mission.projectId) {
        state.addMemory({
          text: `Project mission "${mission.title}" — ${truncate(reportText, 400)}`,
          scope: 'project',
          kind: 'summary',
          source: 'mission',
          projectId: mission.projectId,
          tags: extractTags(`${mission.title} ${mission.objective}`),
        });
      }

      state.appendThreadMessages('nova', [
        {
          id: createId('msg'),
          role: 'user',
          text: `Mission: ${mission.title}\n\n${mission.objective}`.trim(),
          createdAt: now,
        },
        { id: createId('msg'), role: 'nova', text: reportText, createdAt: now },
      ]);

      if (status === 'failed') {
        return {
          ok: false,
          error: `${completed.length} task(s) delivered, ${failedTasks.length} failed. See the report.`,
          missionId,
          text: reportText,
        };
      }

      return { ok: true, text: reportText, missionId };
    }

    return {
      buildSystemPrompt,
      executeAgent,
      executeMission,
      rememberExchange,
      runPlannedMission,
    };
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
          engine.rememberExchange('nova', trimmed, run.text);
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
          engine.rememberExchange(agentId, trimmed, run.text);
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

        if (mission.kind === 'planned') {
          return engine.runPlannedMission(missionId);
        }

        return engine.executeMission(mission);
      }),
    [engine, withBusy],
  );

  const approveMission = useCallback(
    (missionId: string): Promise<RuntimeResult> =>
      withBusy(`mission:${missionId}`, async () => {
        const state = novaRef.current;
        const mission = state.missions.find((entry) => entry.id === missionId);

        if (!mission) return { ok: false, error: 'That mission no longer exists.' };
        if (!mission.approval || mission.approval.status !== 'pending') {
          return { ok: false, error: 'Nothing is waiting for your approval on this mission.' };
        }

        const now = Date.now();
        const approval: MissionApproval = {
          ...mission.approval,
          status: 'approved',
          resolvedAt: now,
        };

        if (approval.kind === 'escalation' && approval.taskId) {
          const tasks = mission.tasks.map((task) =>
            task.id === approval.taskId &&
            (task.status === 'blocked' || task.status === 'failed')
              ? { ...task, status: 'failed' as const }
              : task,
          );
          state.patchMission(missionId, { approval, tasks, status: 'active' });
          state.recordActivity('mission', 'Failure accepted', mission.title);
        } else {
          state.patchMission(missionId, {
            approval,
            status: 'active',
            budget: { ...mission.budget, deadlineAt: now + MISSION_LIMITS.runWindowMs },
          });
          state.recordActivity(
            'mission',
            approval.kind === 'plan' ? 'Plan approved' : 'Mission resumed',
            mission.title,
          );
        }

        return engine.runPlannedMission(missionId, true);
      }),
    [engine, withBusy],
  );

  const rejectMission = useCallback(
    (missionId: string): Promise<RuntimeResult> =>
      withBusy(`mission:${missionId}`, async () => {
        const state = novaRef.current;
        const mission = state.missions.find((entry) => entry.id === missionId);

        if (!mission) return { ok: false, error: 'That mission no longer exists.' };

        const now = Date.now();
        state.patchMission(missionId, {
          status: 'cancelled',
          approval: mission.approval
            ? { ...mission.approval, status: 'rejected', resolvedAt: now }
            : undefined,
          history: [
            {
              id: createId('evt'),
              label: 'Mission cancelled',
              detail: 'Cancelled by the owner.',
              createdAt: now,
            },
            ...mission.history,
          ].slice(0, 60),
        });
        state.recordActivity('mission', 'Mission cancelled', mission.title);
        return { ok: true, missionId };
      }),
    [withBusy],
  );

  const retryMissionTask = useCallback(
    (missionId: string, taskId: string): Promise<RuntimeResult> =>
      withBusy(`mission:${missionId}`, async () => {
        const state = novaRef.current;
        const mission = state.missions.find((entry) => entry.id === missionId);

        if (!mission) return { ok: false, error: 'That mission no longer exists.' };

        if (mission.budget.callsUsed >= MISSION_LIMITS.maxCalls) {
          return {
            ok: false,
            error: `This mission used its ${MISSION_LIMITS.maxCalls} call budget. Create a new mission to continue the work.`,
          };
        }

        const target = mission.tasks.find((task) => task.id === taskId);
        if (!target) return { ok: false, error: 'That task no longer exists.' };

        const now = Date.now();
        const tasks = mission.tasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: 'queued' as const,
                attempt: 0,
                error: undefined,
                review: undefined,
                finishedAt: undefined,
              }
            : task,
        );

        state.patchMission(missionId, {
          tasks,
          status: 'active',
          approval:
            mission.approval?.status === 'pending'
              ? { ...mission.approval, status: 'rejected', resolvedAt: now }
              : mission.approval,
          budget: { ...mission.budget, deadlineAt: now + MISSION_LIMITS.runWindowMs },
          history: [
            {
              id: createId('evt'),
              label: `Task retried: ${target.title}`,
              detail: 'Attempt counter reset by the owner.',
              createdAt: now,
            },
            ...mission.history,
          ].slice(0, 60),
        });

        return engine.runPlannedMission(missionId, true);
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
      approveMission,
      rejectMission,
      retryMissionTask,
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
      approveMission,
      rejectMission,
      retryMissionTask,
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
