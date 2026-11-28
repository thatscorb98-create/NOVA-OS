import { liveKeyGuardCheck, type AuditCheckStatus } from '../audit-checks.ts';
import type { JobContext, JobHandler } from '../jobs.ts';
import { emailProviderStatus } from '../providers/agentmail.ts';
import { searchProviderStatus } from '../providers/search.ts';
import { env } from '../supabase.ts';

/**
 * Phase 9 audit handler.
 *
 * `audit.run` produces one persisted, owner-scoped report. It performs reads
 * only: no email, payment, checkout, discovery, research, production or delivery
 * call is made, and no customer row is written. The only writes are the report
 * checks and the completion event through the service-role RPCs.
 *
 * A missing provider is reported as `blocked`, never as a pass. A broken
 * invariant or an unsafe live switch is a `fail`.
 */

interface AuditRunRow {
  id: string;
  owner_id: string;
  status: string;
  dry_run: boolean;
}

interface DatabaseAudit {
  tablesWithoutRls?: unknown[];
  anonTableGrants?: unknown[];
  definerWithoutSearchPath?: unknown[];
  anonExecutableDefiners?: unknown[];
  succeededWithoutProviderRef?: number;
  ordersWithoutConfirmedPayment?: number;
  ordersWithAmountMismatch?: number;
  deliveredWithoutAcceptedQuote?: number;
  deliveredWithoutMessage?: number;
  productionWithoutPaidOrder?: number;
  sentWithoutProviderRef?: number;
  staleRunningJobs?: number;
  settings?: {
    mode?: string;
    emailEnabled?: boolean;
    discoveryEnabled?: boolean;
    productionEnabled?: boolean;
    paymentsLive?: boolean;
    stripeLiveMode?: boolean;
    aiBudgetCents?: number;
    aiSpendCents?: number;
    aiOverspent?: boolean;
  };
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function zero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const MODE_LABEL: Record<string, string> = {
  paused: 'paused',
  intelligence: 'intelligence',
  outreach: 'outreach',
  sales: 'sales',
  revenue: 'revenue',
  full: 'full',
};

export const auditRun: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const runId = typeof ctx.job.payload.auditRunId === 'string' ? ctx.job.payload.auditRunId : '';
  if (!runId) throw new Error('audit.run needs an auditRunId.');

  const { data: runData, error: runError } = await ctx.admin
    .from('audit_runs')
    .select('id, owner_id, status, dry_run')
    .eq('id', runId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (runError) throw new Error(`Could not read the audit run: ${runError.message}`);
  const run = runData as AuditRunRow | null;
  if (!run) throw new Error('That audit run does not exist for this owner.');
  if (run.dry_run !== true) throw new Error('Phase 9 audits are dry-run only.');
  if (run.status !== 'queued' && run.status !== 'running') {
    return { skipped: true, reason: `audit_${run.status}`, auditRunId: runId };
  }

  const record = async (
    key: string,
    status: AuditCheckStatus,
    detail: string,
    data: Record<string, unknown> = {},
  ): Promise<void> => {
    const { error } = await ctx.admin.rpc('record_audit_check', {
      p_run_id: runId,
      p_key: key,
      p_status: status,
      p_detail: detail,
      p_data: data,
    });
    if (error) throw new Error(`Could not record audit check ${key}: ${error.message}`);
  };

  const { data: databaseData, error: databaseError } = await ctx.admin.rpc('audit_database', {
    p_owner_id: ownerId,
  });

  if (databaseError) {
    await record('database_read', 'fail', `The database audit could not run: ${databaseError.message}`);
    const finished = await ctx.admin.rpc('finish_audit_run', {
      p_run_id: runId,
      p_summary: { error: databaseError.message },
    });
    if (finished.error) throw new Error(`Could not finish the audit: ${finished.error.message}`);
    return { auditRunId: runId, status: 'failed', error: databaseError.message };
  }

  const audit = (databaseData ?? {}) as DatabaseAudit;
  const settings = audit.settings ?? {};

  await record(
    'run_is_dry',
    'pass',
    'The audit row is dry-run only and produced no external call.',
    { dryRun: true },
  );

  // ---- Security: RLS, grants and definer functions ------------------------
  const tablesWithoutRls = list(audit.tablesWithoutRls);
  const anonGrants = list(audit.anonTableGrants);
  const definersWithoutPath = list(audit.definerWithoutSearchPath);
  const anonDefiners = list(audit.anonExecutableDefiners);
  const securityIssues = [
    ...tablesWithoutRls.map((name) => `${name} has RLS disabled`),
    ...anonGrants.map((name) => `anon can read/write ${name}`),
    ...definersWithoutPath.map((name) => `${name}() is SECURITY DEFINER without a search_path`),
    ...anonDefiners.map((name) => `${name}() is executable by anon`),
  ];

  await record(
    'database_security',
    securityIssues.length === 0 ? 'pass' : 'fail',
    securityIssues.length === 0
      ? 'Every public table has RLS, anon has no table grants, and every SECURITY DEFINER function pins search_path.'
      : securityIssues.slice(0, 4).join('; '),
    {
      tablesWithoutRls,
      anonGrants,
      definersWithoutPath,
      anonDefiners,
    },
  );

  // ---- Payment and order integrity ---------------------------------------
  const paymentIssues = [
    zero(audit.succeededWithoutProviderRef),
    zero(audit.ordersWithoutConfirmedPayment),
    zero(audit.ordersWithAmountMismatch),
  ];
  const paymentTotal = paymentIssues.reduce((sum, count) => sum + count, 0);

  await record(
    'payment_integrity',
    paymentTotal === 0 ? 'pass' : 'fail',
    paymentTotal === 0
      ? 'Every paid order is backed by a confirmed payment with the same amount and currency.'
      : `${paymentTotal} payment/order invariant(s) failed.`,
    {
      succeededWithoutProviderRef: paymentIssues[0],
      ordersWithoutConfirmedPayment: paymentIssues[1],
      ordersWithAmountMismatch: paymentIssues[2],
    },
  );

  // ---- Delivery and production integrity ---------------------------------
  const deliveryIssues = [
    zero(audit.deliveredWithoutAcceptedQuote),
    zero(audit.deliveredWithoutMessage),
    zero(audit.productionWithoutPaidOrder),
  ];
  const deliveryTotal = deliveryIssues.reduce((sum, count) => sum + count, 0);

  await record(
    'delivery_integrity',
    deliveryTotal === 0 ? 'pass' : 'fail',
    deliveryTotal === 0
      ? 'Every delivered item is linked to an accepted quote and a delivery message, and every production job has a paid order.'
      : `${deliveryTotal} delivery/production invariant(s) failed.`,
    {
      deliveredWithoutAcceptedQuote: deliveryIssues[0],
      deliveredWithoutMessage: deliveryIssues[1],
      productionWithoutPaidOrder: deliveryIssues[2],
    },
  );

  // ---- Queue recovery and duplicate sends --------------------------------
  const staleJobs = zero(audit.staleRunningJobs);
  const sentWithoutRef = zero(audit.sentWithoutProviderRef);

  await record(
    'queue_recovery',
    staleJobs === 0 ? 'pass' : 'fail',
    staleJobs === 0
      ? 'No job is left running past its lock; the recovery sweep has nothing to reclaim.'
      : `${staleJobs} job(s) are running past their lock and need recovery.`,
    { staleRunningJobs: staleJobs, sentWithoutProviderRef: sentWithoutRef },
  );

  if (sentWithoutRef > 0) {
    await record(
      'duplicate_sends',
      'fail',
      `${sentWithoutRef} message(s) are marked sent without a provider reference.`,
      { sentWithoutProviderRef: sentWithoutRef },
    );
  } else {
    await record(
      'duplicate_sends',
      'pass',
      'No sent message is missing its provider reference.',
    );
  }

  // ---- Spending cap -------------------------------------------------------
  const overspent = settings.aiOverspent === true;
  await record(
    'spending_cap',
    overspent ? 'fail' : 'pass',
    overspent
      ? 'Recorded AI spend exceeds the owner budget.'
      : 'Recorded AI spend is within the owner budget (or the budget is zero).',
    {
      aiBudgetCents: zero(settings.aiBudgetCents),
      aiSpendCents: zero(settings.aiSpendCents),
    },
  );

  // ---- Live gates stay closed --------------------------------------------
  const liveFlags = [
    settings.emailEnabled === true ? 'email' : null,
    settings.paymentsLive === true ? 'payments' : null,
    settings.stripeLiveMode === true ? 'live Stripe mode' : null,
    settings.productionEnabled === true ? 'automatic production' : null,
  ].filter((flag): flag is string => flag !== null);

  await record(
    'live_gates',
    liveFlags.length === 0 ? 'pass' : 'fail',
    liveFlags.length === 0
      ? `Every external capability is off in ${MODE_LABEL[String(settings.mode)] ?? String(settings.mode)} mode.`
      : `These live capabilities are on: ${liveFlags.join(', ')}. Phase 9 expects them off.`,
    { enabled: liveFlags, mode: settings.mode ?? null },
  );

  // ---- Provider configuration --------------------------------------------
  const search = searchProviderStatus();
  const email = emailProviderStatus();
  const stripeKey = env('STRIPE_SECRET_KEY');
  const stripeWebhook = env('STRIPE_WEBHOOK_SECRET');
  const liveStripeKey = Boolean(stripeKey?.startsWith('sk_live_'));
  const missing = [
    search.configured ? null : 'search',
    email.configured ? null : 'email',
    stripeKey ? null : 'Stripe checkout',
    stripeWebhook ? null : 'Stripe webhook',
  ].filter((item): item is string => item !== null);

  await record(
    'provider_config',
    missing.length === 0 ? 'pass' : 'blocked',
    missing.length === 0
      ? 'Search, email and Stripe test credentials are configured; a controlled live run can be scheduled.'
      : `A controlled live run cannot start: missing ${missing.join(', ')}. No provider call was attempted.`,
    {
      search: search.configured,
      email: email.configured,
      stripeSecret: Boolean(stripeKey),
      stripeWebhook: Boolean(stripeWebhook),
      liveStripeKey,
      missing,
    },
  );

  const keyGuard = liveKeyGuardCheck(stripeKey);
  await record('live_key_guard', keyGuard.status, keyGuard.detail, keyGuard.data);

  const finished = await ctx.admin.rpc('finish_audit_run', {
    p_run_id: runId,
    p_summary: {
      mode: settings.mode ?? null,
      missingProviders: missing,
      liveGates: liveFlags,
    },
  });

  if (finished.error) throw new Error(`Could not finish the audit: ${finished.error.message}`);

  const report = (Array.isArray(finished.data) ? finished.data[0] : finished.data) as
    | { status?: string; summary?: Record<string, unknown> }
    | null;

  await ctx.log(
    report?.status === 'passed' ? 'info' : 'warn',
    `Dry-run audit finished: ${report?.status ?? 'unknown'}.`,
    { auditRunId: runId, summary: report?.summary ?? {} },
  );

  return {
    auditRunId: runId,
    status: report?.status ?? 'unknown',
    summary: report?.summary ?? {},
  };
};
