import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { atlasDiscover, atlasResearch, sterlingScore } from './handlers/discovery.ts';
import { echoDraftEmail, relaySendEmail } from './handlers/outreach.ts';

/**
 * Job handlers.
 *
 * Phase 1 deliberately ships a small, honest set: a liveness ping, a recovery
 * sweep, and a real company-memory write. Discovery, outreach, sales, payments
 * and production handlers arrive in later phases — there are no placeholders
 * here that pretend to do work.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JobRow {
  id: string;
  owner_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  checkpoint: Record<string, unknown>;
}

export interface JobContext {
  job: JobRow;
  admin: SupabaseClient;
  log: (level: LogLevel, message: string, data?: Record<string, unknown>) => Promise<void>;
  checkpoint: (patch: Record<string, unknown>) => Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

const SYSTEM_PREFIX = 'system.';

/** System jobs are allowed to run even while the company is paused. */
export function isSystemJob(kind: string): boolean {
  return kind.startsWith(SYSTEM_PREFIX);
}

const MEMORY_SCOPES = new Set(['company', 'agent', 'project', 'customer']);
const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'summary', 'note']);

export const HANDLERS: Record<string, JobHandler> = {
  'system.ping': async (ctx) => {
    await ctx.log('info', 'Queue ping processed.');
    return {
      pong: true,
      at: new Date().toISOString(),
      attempt: ctx.job.attempts,
      echo: ctx.job.payload,
    };
  },

  'system.health_sweep': async (ctx) => {
    const { data, error } = await ctx.admin.rpc('requeue_stale_jobs');
    if (error) throw new Error(`Recovery sweep failed: ${error.message}`);

    const requeued = typeof data === 'number' ? data : 0;
    await ctx.log(
      requeued > 0 ? 'warn' : 'info',
      requeued > 0
        ? `Recovered ${requeued} job(s) whose worker lock had expired.`
        : 'Recovery sweep found no stale jobs.',
      { requeued },
    );

    return { requeued };
  },

  'atlas.discover': atlasDiscover,
  'atlas.research': atlasResearch,
  'sterling.score': sterlingScore,
  'echo.draft_email': echoDraftEmail,
  'relay.send_email': relaySendEmail,

  'memory.remember': async (ctx) => {
    const rawText = ctx.job.payload.text;
    const text = typeof rawText === 'string' ? rawText.trim().slice(0, 1200) : '';

    if (!text) throw new Error('memory.remember needs a non-empty text payload.');

    const rawScope = typeof ctx.job.payload.scope === 'string' ? ctx.job.payload.scope : 'company';
    const scope = MEMORY_SCOPES.has(rawScope) ? rawScope : 'company';

    const rawKind = typeof ctx.job.payload.kind === 'string' ? ctx.job.payload.kind : 'note';
    const kind = MEMORY_KINDS.has(rawKind) ? rawKind : 'note';

    const projectId = typeof ctx.job.payload.projectId === 'string' ? ctx.job.payload.projectId : null;
    const agentId = typeof ctx.job.payload.agentId === 'string' ? ctx.job.payload.agentId : null;

    if (scope === 'project' && !projectId) {
      throw new Error('A project-scoped memory needs a projectId.');
    }

    const tags = Array.isArray(ctx.job.payload.tags)
      ? (ctx.job.payload.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
      : [];

    const { data, error } = await ctx.admin
      .from('company_memory')
      .insert({
        owner_id: ctx.job.owner_id,
        scope,
        kind,
        source: 'system',
        agent_id: scope === 'agent' ? agentId : null,
        project_id: scope === 'project' ? projectId : null,
        text,
        tags,
        pinned: ctx.job.payload.pinned === true,
      })
      .select('id');

    // 23505 = the dedupe index already holds this exact text. That is success:
    // the knowledge is present, and a retried job must not duplicate it.
    if (error && error.code !== '23505') {
      throw new Error(`Could not write company memory: ${error.message}`);
    }

    const deduplicated = Boolean(error) || !data || data.length === 0;
    await ctx.log(
      'info',
      deduplicated ? 'Memory already present; nothing duplicated.' : 'Company memory stored.',
      { scope, kind },
    );

    return { memoryId: deduplicated ? null : data?.[0]?.id ?? null, deduplicated, scope, kind };
  },
};

export function handlerFor(kind: string): JobHandler | null {
  return HANDLERS[kind] ?? null;
}

export function knownJobKinds(): string[] {
  return Object.keys(HANDLERS).sort();
}
