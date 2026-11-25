import { isAgentId } from '@/data/agents';
import type {
  AgentId,
  Mission,
  MissionBudget,
  MissionTask,
  MissionTaskStatus,
} from '@/types/nova';

/**
 * Hard limits for the mission execution loop.
 *
 * These are enforced by the runtime, not just the UI: a run can never plan more
 * tasks, retry more times, spend more model calls or run for longer than this.
 * A single mission costs at most maxCalls model requests.
 */
export const MISSION_LIMITS = {
  maxTasks: 5,
  maxAttempts: 2,
  maxCalls: 24,
  /** One uninterrupted run window. A paused mission can resume with a new window. */
  runWindowMs: 8 * 60_000,
  /** Absolute cap on loop iterations, independent of the call budget. */
  maxSteps: 60,
} as const;

export function defaultMissionBudget(): MissionBudget {
  return {
    maxTasks: MISSION_LIMITS.maxTasks,
    maxCalls: MISSION_LIMITS.maxCalls,
    maxAttempts: MISSION_LIMITS.maxAttempts,
    callsUsed: 0,
    startedAt: Date.now(),
    deadlineAt: 0,
  };
}

export interface MissionProgress {
  total: number;
  complete: number;
  failed: number;
  running: number;
  queued: number;
  blocked: number;
  percent: number;
}

export function getMissionProgress(mission: Mission): MissionProgress {
  const counts: Record<MissionTaskStatus, number> = {
    queued: 0,
    running: 0,
    review: 0,
    complete: 0,
    failed: 0,
    blocked: 0,
  };

  for (const task of mission.tasks) {
    counts[task.status] += 1;
  }

  const total = mission.tasks.length;
  const percent = total === 0 ? 0 : Math.round((counts.complete / total) * 100);

  return {
    total,
    complete: counts.complete,
    failed: counts.failed + counts.blocked,
    running: counts.running + counts.review,
    queued: counts.queued,
    blocked: counts.blocked,
    percent,
  };
}

/** True when the mission is stopped waiting for the owner. */
export function hasPendingApproval(mission: Mission): boolean {
  return mission.approval?.status === 'pending';
}

/** True for missions the owner still has to act on or that are still moving. */
export function isMissionOpen(mission: Mission): boolean {
  return (
    mission.status !== 'complete' &&
    mission.status !== 'failed' &&
    mission.status !== 'cancelled'
  );
}

/**
 * Next task that can run: queued, with every dependency already complete.
 * Returns null when the queue is empty or deadlocked.
 */
export function nextRunnableTask(tasks: MissionTask[]): MissionTask | null {
  const done = new Set(tasks.filter((task) => task.status === 'complete').map((task) => task.id));

  return (
    tasks.find(
      (task) =>
        task.status === 'queued' && task.dependsOn.every((dependency) => done.has(dependency)),
    ) ?? null
  );
}

/** Tasks that can never run because a dependency failed or was blocked. */
export function strandedTasks(tasks: MissionTask[]): MissionTask[] {
  const dead = new Set(
    tasks
      .filter((task) => task.status === 'failed' || task.status === 'blocked')
      .map((task) => task.id),
  );

  return tasks.filter(
    (task) =>
      task.status === 'queued' && task.dependsOn.some((dependency) => dead.has(dependency)),
  );
}

export interface PlannedTaskDraft {
  title: string;
  brief: string;
  agentId: AgentId;
  dependsOnIndexes: number[];
}

export type PlanParseResult =
  | { ok: true; tasks: PlannedTaskDraft[]; trimmed: boolean }
  | { ok: false; error: string };

/** Extract the first JSON object from model output, tolerating code fences. */
export function extractJsonObject(raw: string): unknown {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Validate a model-written plan.
 *
 * Rules: 1..maxTasks tasks, a real delegatable agent per task, dependencies only
 * pointing at earlier tasks (so the graph is acyclic and ordered), and a
 * non-empty brief. Anything invalid is dropped; if nothing survives it fails.
 */
export function parseMissionPlan(raw: string): PlanParseResult {
  const parsed = extractJsonObject(raw) as { tasks?: unknown } | null;
  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : null;

  if (!list) {
    return { ok: false, error: 'NOVA did not return a readable plan. Run it again to replan.' };
  }

  const candidates = list.slice(0, MISSION_LIMITS.maxTasks);
  const trimmed = list.length > MISSION_LIMITS.maxTasks;

  const drafts: PlannedTaskDraft[] = [];

  candidates.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;

    const title = clampText(record.title, 120);
    const brief = clampText(record.brief ?? record.objective ?? record.task, 1400);
    const agent = String(record.agent ?? '').toLowerCase();

    if (!title || !brief) return;
    if (!isAgentId(agent) || agent === 'nova') return;

    const rawDeps = Array.isArray(record.depends_on)
      ? record.depends_on
      : Array.isArray(record.dependsOn)
        ? record.dependsOn
        : [];

    const index = drafts.length;
    const dependsOnIndexes = Array.from(
      new Set(
        rawDeps
          .map((value) => (typeof value === 'number' ? value : Number(value)))
          .filter((value) => Number.isInteger(value) && value >= 0 && value < index),
      ),
    );

    drafts.push({
      title,
      brief,
      agentId: agent,
      dependsOnIndexes,
    });
  });

  if (drafts.length === 0) {
    return {
      ok: false,
      error: 'The plan had no valid tasks. NOVA must name a real specialist for each task.',
    };
  }

  return { ok: true, tasks: drafts, trimmed };
}

export interface ReviewParseResult {
  verdict: 'pass' | 'retry';
  notes: string;
}

/** Read the reviewer's verdict, falling back to a pass so a bad reply cannot loop. */
export function parseMissionReview(raw: string): ReviewParseResult {
  const parsed = extractJsonObject(raw) as
    | { verdict?: unknown; notes?: unknown; reason?: unknown }
    | null;

  if (parsed) {
    const verdict = String(parsed.verdict ?? '').toLowerCase();
    const notes = clampText(parsed.notes ?? parsed.reason ?? '', 400);

    if (verdict === 'retry' || verdict === 'fail' || verdict === 'revise') {
      return { verdict: 'retry', notes: notes || 'The reviewer asked for a stronger deliverable.' };
    }
    if (verdict === 'pass' || verdict === 'approve' || verdict === 'ok') {
      return { verdict: 'pass', notes: notes || 'Meets the brief.' };
    }
  }

  const text = raw.trim();
  if (/^retry\b/i.test(text) || /\bretry requested\b/i.test(text)) {
    return { verdict: 'retry', notes: clampText(text, 400) };
  }
  if (/^pass\b/i.test(text) || /\bapproved\b/i.test(text)) {
    return { verdict: 'pass', notes: clampText(text, 400) || 'Meets the brief.' };
  }

  return {
    verdict: 'pass',
    notes: 'Reviewer reply was unreadable, so the output was accepted unchanged.',
  };
}
