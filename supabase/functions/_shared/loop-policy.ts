/**
 * Phase 8 loop policy.
 *
 * The scheduler reads one snapshot per owner per minute, but it only queues a
 * `nova.orchestrate` cycle when the snapshot shows work. That keeps an idle
 * company to one read-only check instead of a job, a cycle row and an event
 * every minute.
 *
 * `urgent` means a customer or a paid order is waiting. It always bypasses the
 * idle backoff, so slowing the idle cadence can never delay due work. Discovery
 * is deliberately not urgent: it is checked on the backoff and at most once per
 * UTC day.
 */

export interface LoopNext {
  followUpId: string | null;
  replyEventId: number | null;
  production: { jobId: string; version: number } | null;
  delivery: { jobId: string; deliverableId: string } | null;
  approvedMessageId: string | null;
  leadId: string | null;
  deliveredMessageId: string | null;
}

export interface LoopCounts {
  leadsTotal: number;
  leadsQualified: number;
  leadsToday: number;
  leadsWithoutOutreach: number;
  draftsPending: number;
  approvedReady: number;
  dueFollowUps: number;
  repliesUndrafted: number;
  dealsReady: number;
  productionQueued: number;
  productionReady: number;
  deliveriesUnsent: number;
  deliveredWithoutPlan: number;
  discoveryToday: number;
  jobsQueued: number;
  jobsDead: number;
  ordersPaid: number;
}

export interface LoopSnapshot {
  mode: string;
  emailEnabled: boolean;
  discoveryEnabled: boolean;
  productionEnabled: boolean;
  dailyLeadCap: number;
  dailyEmailCap: number;
  aiBudgetCents: number;
  aiSpendCents: number;
  aiRemainingCents: number;
  counts: LoopCounts;
  next: LoopNext;
  serverTime: string;
}

export interface LoopUrgency {
  /** A customer, a reply, a paid order or a deliverable is waiting. */
  urgent: boolean;
  /** Anything the loop could act on, including discovery. */
  work: boolean;
}

export const OUTREACH_MODES = new Set<string>(['outreach', 'sales', 'revenue', 'full']);

export function loopUrgency(snapshot: LoopSnapshot): LoopUrgency {
  if (snapshot.mode === 'paused') return { urgent: false, work: false };

  const canEmail = snapshot.emailEnabled && OUTREACH_MODES.has(snapshot.mode);
  const counts = snapshot.counts;

  const urgent =
    // Customer conversations.
    counts.dueFollowUps > 0 ||
    counts.repliesUndrafted > 0 ||
    // Paid work.
    (canEmail && counts.deliveriesUnsent > 0) ||
    (snapshot.productionEnabled && counts.productionQueued > 0) ||
    // Prospect work that is safe in any non-paused mode.
    counts.leadsWithoutOutreach > 0 ||
    counts.deliveredWithoutPlan > 0 ||
    (canEmail && counts.approvedReady > 0);

  const discoveryDue =
    snapshot.discoveryEnabled &&
    snapshot.dailyLeadCap > 0 &&
    counts.leadsToday < snapshot.dailyLeadCap &&
    counts.discoveryToday === 0;

  return { urgent, work: urgent || discoveryDue };
}
