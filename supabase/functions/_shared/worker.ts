import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { handlerFor, type JobRow, type LogLevel } from './jobs.ts';
import { runsWhilePaused } from './pause-policy.ts';
import { SERVICE_VERSION } from './supabase.ts';

/**
 * The queue loop.
 *
 * Claim with SKIP LOCKED, run the handler, checkpoint as it goes, complete or
 * fail with backoff. A paused company defers every job except system maintenance
 * and an owner-started dry-run audit, instead of burning attempts on them.
 * Nothing here invents activity: every row it writes is the result of a handler
 * that actually ran.
 */

export interface RunQueueOptions {
  admin: SupabaseClient;
  workerId: string;
  limit?: number;
  /** null = every owner (cron / service role). */
  ownerId?: string | null;
}

export interface JobOutcome {
  id: string;
  kind: string;
  status: 'succeeded' | 'failed' | 'released' | 'unknown';
  detail?: string;
}

export interface RunQueueSummary {
  workerId: string;
  claimed: number;
  succeeded: number;
  failed: number;
  released: number;
  jobs: JobOutcome[];
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 3;
  return Math.max(1, Math.min(Math.trunc(value as number), 10));
}

export async function runQueue({
  admin,
  workerId,
  limit,
  ownerId = null,
}: RunQueueOptions): Promise<RunQueueSummary> {
  const summary: RunQueueSummary = {
    workerId,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    released: 0,
    jobs: [],
  };

  await admin.rpc('heartbeat_worker', {
    p_worker_id: workerId,
    p_status: 'working',
    p_version: SERVICE_VERSION,
    p_owner_id: ownerId,
  });

  const { data, error } = await admin.rpc('claim_agent_jobs', {
    p_worker_id: workerId,
    p_limit: clampLimit(limit),
    p_owner_id: ownerId,
  });

  if (error) {
    await admin.rpc('heartbeat_worker', {
      p_worker_id: workerId,
      p_status: 'error',
      p_version: SERVICE_VERSION,
      p_owner_id: ownerId,
    });
    throw new Error(`Could not claim jobs: ${error.message}`);
  }

  const jobs = (data ?? []) as JobRow[];
  summary.claimed = jobs.length;

  for (const job of jobs) {
    const log = async (level: LogLevel, message: string, extra: Record<string, unknown> = {}) => {
      await admin.from('agent_events').insert({
        owner_id: job.owner_id,
        job_id: job.id,
        agent_id: typeof job.payload.agentId === 'string' ? job.payload.agentId : null,
        kind: job.kind,
        level,
        message: message.slice(0, 800),
        data: extra,
      });
    };

    const checkpoint = async (patch: Record<string, unknown>) => {
      await admin.rpc('checkpoint_agent_job', { p_job_id: job.id, p_checkpoint: patch });
    };

    try {
      const settings = await admin
        .from('business_settings')
        .select('autonomy_mode')
        .eq('owner_id', job.owner_id)
        .maybeSingle();

      const paused = settings.data?.autonomy_mode === 'paused';

      if (paused && !runsWhilePaused(job.kind, job.payload)) {
        await admin.rpc('release_agent_job', {
          p_job_id: job.id,
          p_delay: '10 minutes',
          p_reason: 'The company is paused; this job will run when it is resumed.',
        });
        await log('warn', 'Job deferred because the company is paused.');
        summary.released += 1;
        summary.jobs.push({ id: job.id, kind: job.kind, status: 'released', detail: 'paused' });
        continue;
      }

      const handler = handlerFor(job.kind);

      if (!handler) {
        throw new Error(`No handler is registered for job kind "${job.kind}".`);
      }

      const result = await handler({ job, admin, log, checkpoint });

      await admin.rpc('complete_agent_job', {
        p_job_id: job.id,
        p_result: { ...result, worker: workerId, finishedAt: new Date().toISOString() },
      });

      summary.succeeded += 1;
      summary.jobs.push({ id: job.id, kind: job.kind, status: 'succeeded' });
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);

      await admin.rpc('fail_agent_job', { p_job_id: job.id, p_error: message });
      await log('error', `Job failed: ${message}`);

      summary.failed += 1;
      summary.jobs.push({ id: job.id, kind: job.kind, status: 'failed', detail: message });
    }
  }

  await admin.rpc('heartbeat_worker', {
    p_worker_id: workerId,
    p_status: 'idle',
    p_version: SERVICE_VERSION,
    p_owner_id: ownerId,
  });

  return summary;
}
