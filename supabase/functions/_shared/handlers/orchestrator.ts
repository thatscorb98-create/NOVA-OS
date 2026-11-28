import type { JobContext, JobHandler } from '../jobs.ts';

/**
 * Phase 8: the autonomous company loop.
 *
 *   nova.orchestrate   → read one owner-scoped snapshot, choose one next action
 *   relay.plan_retention → schedule the receipt/review/recurring follow-ups
 *
 * One action per cycle on purpose: every step is visible in `company_cycles`
 * and in the event log, a failure cannot cascade, and the next scheduled cycle
 * picks up whatever changed. The loop never sends, charges or produces directly
 * — it enqueues the Phase 2–7 handlers, which keep their own gates.
 *
 * What it will not do:
 *   * create a quote, a payment record or a checkout. Those need the customer's
 *     explicit acceptance and, for checkout, the owner's payments switch.
 *   * buy, upgrade or subscribe to anything. There is no such code path here.
 *   * retry a dead job forever. Dead work is reported, not silently resurrected.
 */

interface LoopNext {
  followUpId: string | null;
  replyEventId: number | null;
  production: { jobId: string; version: number } | null;
  delivery: { jobId: string; deliverableId: string } | null;
  approvedMessageId: string | null;
  leadId: string | null;
  deliveredMessageId: string | null;
}

interface LoopSnapshot {
  mode: string;
  emailEnabled: boolean;
  discoveryEnabled: boolean;
  productionEnabled: boolean;
  dailyLeadCap: number;
  dailyEmailCap: number;
  aiBudgetCents: number;
  aiSpendCents: number;
  aiRemainingCents: number;
  counts: Record<string, number>;
  next: LoopNext;
  serverTime: string;
}

const OUTREACH_MODES = new Set(['outreach', 'sales', 'revenue', 'full']);

async function enqueue(
  ctx: JobContext,
  kind: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  priority: number,
): Promise<string | null> {
  const { data, error } = await ctx.admin.rpc('enqueue_agent_job', {
    p_kind: kind,
    p_payload: payload,
    p_idempotency_key: idempotencyKey,
    p_priority: priority,
    p_owner_id: ctx.job.owner_id,
  });

  if (error) throw new Error(`Could not queue ${kind}: ${error.message}`);

  const job = (Array.isArray(data) ? data[0] : data) as { id?: string } | null;
  return job?.id ?? null;
}

async function recordCycle(
  ctx: JobContext,
  cycleKey: string,
  status: 'action' | 'idle' | 'paused' | 'blocked',
  decision: string,
  detail: Record<string, unknown>,
  jobId: string | null,
): Promise<void> {
  const { error } = await ctx.admin.rpc('record_company_cycle', {
    p_owner_id: ctx.job.owner_id,
    p_cycle_key: cycleKey,
    p_status: status,
    p_decision: decision,
    p_detail: detail,
    p_job_id: jobId,
  });

  if (error) throw new Error(`Could not record the company cycle: ${error.message}`);
}

export const novaOrchestrate: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const rawKey = ctx.job.payload.cycleKey;
  const cycleKey =
    typeof rawKey === 'string' && rawKey.trim().length > 0
      ? rawKey.trim().slice(0, 120)
      : `job:${ctx.job.id}`;

  const { data, error } = await ctx.admin.rpc('nova_loop_snapshot', { p_owner_id: ownerId });
  if (error) throw new Error(`Could not read the company snapshot: ${error.message}`);

  const snapshot = data as LoopSnapshot;
  if (!snapshot || typeof snapshot.mode !== 'string') {
    throw new Error('The company snapshot was empty.');
  }

  const detail = {
    mode: snapshot.mode,
    counts: snapshot.counts,
    aiBudgetCents: snapshot.aiBudgetCents,
    aiSpendCents: snapshot.aiSpendCents,
    aiRemainingCents: snapshot.aiRemainingCents,
    serverTime: snapshot.serverTime,
  };

  if (snapshot.mode === 'paused') {
    await recordCycle(ctx, cycleKey, 'paused', 'paused', detail, null);
    return { status: 'paused', decision: 'paused' };
  }

  const act = async (
    kind: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    priority: number,
    decision: string,
  ) => {
    const jobId = await enqueue(ctx, kind, payload, idempotencyKey, priority);
    await recordCycle(ctx, cycleKey, 'action', decision, { ...detail, kind, idempotencyKey }, jobId);
    await ctx.log('info', `NOVA queued ${kind}.`, { decision, jobId, idempotencyKey });

    return { status: 'action', decision, kind, jobId };
  };

  // A closed gate must not stall unrelated work. The loop records the reason and
  // falls through to the next useful action; if none exists, the cycle is blocked.
  const holds: string[] = [];

  // 1. A customer is waiting for a follow-up that is already due.
  if (snapshot.counts.dueFollowUps > 0 && snapshot.next.followUpId) {
    return act(
      'echo.draft_follow_up',
      { followUpId: snapshot.next.followUpId },
      `loop:follow-up:${snapshot.next.followUpId}`,
      80,
      'draft_follow_up',
    );
  }

  // 2. A customer replied and has no reply draft yet.
  if (snapshot.counts.repliesUndrafted > 0 && snapshot.next.replyEventId) {
    return act(
      'closer.draft_reply',
      { eventId: snapshot.next.replyEventId },
      `loop:reply:${snapshot.next.replyEventId}`,
      80,
      'draft_reply',
    );
  }

  // 3. Paid work passed QA and is not delivered yet.
  if (snapshot.counts.deliveriesUnsent > 0 && snapshot.next.delivery) {
    if (!snapshot.emailEnabled || !OUTREACH_MODES.has(snapshot.mode)) {
      holds.push('delivery is waiting: email or the company mode is not open for delivery.');
    } else {
      return act(
        'relay.send_delivery',
        { deliverableId: snapshot.next.delivery.deliverableId },
        `loop:delivery:${snapshot.next.delivery.deliverableId}`,
        60,
        'deliver_work',
      );
    }
  }

  // 4. A paid order has production queued and the owner has armed production.
  if (snapshot.productionEnabled && snapshot.counts.productionQueued > 0 && snapshot.next.production) {
    return act(
      'forge.produce',
      { jobId: snapshot.next.production.jobId },
      `forge:${snapshot.next.production.jobId}:v${snapshot.next.production.version}`,
      50,
      'produce_paid_order',
    );
  }

  // 5. An approved draft is waiting for the email switch and a high enough mode.
  if (snapshot.counts.approvedReady > 0 && snapshot.next.approvedMessageId) {
    if (!snapshot.emailEnabled || !OUTREACH_MODES.has(snapshot.mode)) {
      holds.push('an approved email is waiting: email is off or the mode is below outreach.');
    } else {
      return act(
        'relay.send_email',
        { messageId: snapshot.next.approvedMessageId },
        `loop:send:${snapshot.next.approvedMessageId}`,
        70,
        'send_approved_email',
      );
    }
  }

  // 6. A delivered customer has no receipt/review/recurring plan yet.
  if (snapshot.counts.deliveredWithoutPlan > 0 && snapshot.next.deliveredMessageId) {
    return act(
      'relay.plan_retention',
      { messageId: snapshot.next.deliveredMessageId },
      `loop:retention:${snapshot.next.deliveredMessageId}`,
      90,
      'plan_retention',
    );
  }

  // 7. A qualified lead has a real contact address and no outreach at all.
  if (snapshot.counts.leadsWithoutOutreach > 0 && snapshot.next.leadId) {
    return act(
      'echo.draft_email',
      { leadId: snapshot.next.leadId, agentId: 'echo' },
      `loop:draft:${snapshot.next.leadId}`,
      95,
      'draft_new_outreach',
    );
  }

  // 8. Nothing to work, so look for new businesses — within the daily lead cap.
  if (
    snapshot.discoveryEnabled &&
    snapshot.dailyLeadCap > 0 &&
    snapshot.counts.leadsToday < snapshot.dailyLeadCap
  ) {
    const day = new Date(snapshot.serverTime).toISOString().slice(0, 10);
    return act(
      'atlas.discover',
      { scheduledBy: 'nova.orchestrate', day },
      `loop:discover:${day}`,
      110,
      'discover_leads',
    );
  }

  const reason = holds[0] ??
    (snapshot.counts.productionReady > 0
      ? 'production is ready but no open delivery is linked to it.'
      : snapshot.counts.jobsDead > 0
        ? 'there is dead work that needs the owner, not another automatic retry.'
        : snapshot.discoveryEnabled
          ? 'the daily lead cap is reached and every current customer is up to date.'
          : 'discovery is off and there is no due customer work.');

  const status = holds.length > 0 ? 'blocked' : 'idle';
  await recordCycle(ctx, cycleKey, status, status, { ...detail, holds, reason }, null);
  if (holds.length > 0) await ctx.log('warn', `NOVA held work: ${reason}`, { holds });

  return { status, decision: status, reason, holds };
};

/**
 * Schedule the three retention follow-ups for a delivery that already went out.
 * The database re-checks suppression, contact opt-out and lead do-not-contact,
 * so a preference change since delivery still wins.
 */
export const relayPlanRetention: JobHandler = async (ctx: JobContext) => {
  const messageId = typeof ctx.job.payload.messageId === 'string' ? ctx.job.payload.messageId : '';
  if (!messageId) throw new Error('relay.plan_retention needs a messageId.');

  const { data, error } = await ctx.admin.rpc('schedule_delivery_follow_ups', {
    p_message_id: messageId,
    p_owner_id: ctx.job.owner_id,
  });

  if (error) throw new Error(`Could not schedule the retention plan: ${error.message}`);

  const summary = (Array.isArray(data) ? data[0] : data) as
    | { scheduled?: string[]; skipped?: string | null }
    | null;

  if (summary?.skipped === 'opt_out') {
    await ctx.log('info', 'Retention plan skipped: the customer opted out.', { messageId });
    return { skipped: true, reason: 'opt_out', messageId };
  }

  const scheduled = Array.isArray(summary?.scheduled) ? summary.scheduled : [];
  await ctx.log('info', `Retention follow-ups scheduled: ${scheduled.join(', ') || 'none'}.`, {
    messageId,
    scheduled,
  });

  return { messageId, scheduled };
};
