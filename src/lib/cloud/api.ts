import type { SupabaseClient } from '@supabase/supabase-js';

import type { MemoryRecord } from '@/types/nova';
import type {
  AutonomyMode,
  CloudCatalogService,
  CloudCustomerHistory,
  CloudDeal,
  CloudDeliverable,
  CloudDiscoveryRun,
  CloudEmailAccount,
  CloudEvent,
  CloudExpense,
  CloudFinanceSummary,
  CloudFollowUp,
  CloudHealth,
  CloudJob,
  CloudLead,
  CloudOrder,
  CloudProductionFile,
  CloudProductionJob,
  CloudProductionQa,
  CloudOutreachMessage,
  CloudPaymentIntent,
  CloudQuote,
  CloudReadyLead,
  CloudReply,
  CloudResult,
  DealStage,
} from '@/lib/cloud/types';

/**
 * Cloud API surface.
 *
 * Every call goes through the signed-in user's session and therefore through
 * row level security. Failures are returned as messages, never as fabricated
 * success: an empty queue reads as empty, not as "0 delivered".
 */

export function describeCloudError(error: unknown): string {
  if (!error) return 'The cloud request failed.';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  const record = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
  if (typeof record.message === 'string' && record.message.length > 0) return record.message;
  if (typeof record.details === 'string' && record.details.length > 0) return record.details;
  if (typeof record.hint === 'string' && record.hint.length > 0) return record.hint;
  if (typeof record.code === 'string') return `Cloud error ${record.code}.`;

  return 'The cloud request failed.';
}

export async function loadHealth(client: SupabaseClient): Promise<CloudHealth | null> {
  const { data, error } = await client.rpc('business_health');
  if (error) throw new Error(describeCloudError(error));
  if (!data) return null;

  const health = data as CloudHealth;
  if (!health.ok) throw new Error('The cloud health check reported a problem.');
  return health;
}

export async function loadJobs(client: SupabaseClient, limit = 12): Promise<CloudJob[]> {
  const { data, error } = await client
    .from('agent_jobs')
    .select('id, kind, status, attempts, max_attempts, created_at, finished_at, last_error')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudJob[];
}

export async function loadEvents(client: SupabaseClient, limit = 12): Promise<CloudEvent[]> {
  const { data, error } = await client
    .from('agent_events')
    .select('id, kind, level, message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudEvent[];
}

/** Enqueue a liveness job. Idempotent per minute, so a double tap is harmless. */
export async function enqueuePing(client: SupabaseClient): Promise<string | null> {
  const bucket = Math.floor(Date.now() / 60_000);

  const { data, error } = await client.rpc('enqueue_agent_job', {
    p_kind: 'system.ping',
    p_payload: { source: 'app', bucket },
    p_idempotency_key: `ping:${bucket}`,
    p_priority: 50,
  });

  if (error) throw new Error(describeCloudError(error));

  const job = data as { id?: string } | null;
  return job?.id ?? null;
}

/** Ask the worker to drain the caller's queue right now. */
export async function runWorker(
  client: SupabaseClient,
  limit = 3,
): Promise<{ claimed: number; succeeded: number; failed: number; released: number }> {
  const { data, error } = await client.functions.invoke('worker', { body: { limit } });

  if (error) throw new Error(describeCloudError(error));

  const payload = data as {
    ok?: boolean;
    claimed?: number;
    succeeded?: number;
    failed?: number;
    released?: number;
    error?: string;
  } | null;

  if (!payload?.ok) {
    throw new Error(payload?.error ?? 'The worker did not accept the request.');
  }

  return {
    claimed: payload.claimed ?? 0,
    succeeded: payload.succeeded ?? 0,
    failed: payload.failed ?? 0,
    released: payload.released ?? 0,
  };
}

export async function cancelJob(client: SupabaseClient, jobId: string): Promise<boolean> {
  const { data, error } = await client.rpc('cancel_agent_job', { p_job_id: jobId });
  if (error) throw new Error(describeCloudError(error));
  return Boolean(data);
}

/** Import the phone's memory ledger into company memory. Additive and idempotent. */
export async function syncLocalMemories(
  client: SupabaseClient,
  memories: MemoryRecord[],
): Promise<{ inserted: number; skipped: number; received: number }> {
  const payload = {
    memories: memories.slice(0, 500).map((memory) => ({
      text: memory.text,
      scope: memory.scope,
      kind: memory.kind,
      tags: memory.tags,
      pinned: memory.pinned,
      agentId: memory.agentId ?? null,
      projectId: memory.projectId ?? null,
    })),
  };

  const { data, error } = await client.rpc('sync_local_snapshot', { p_payload: payload });
  if (error) throw new Error(describeCloudError(error));

  const result = data as { inserted?: number; skipped?: number; received?: number } | null;

  return {
    inserted: result?.inserted ?? 0,
    skipped: result?.skipped ?? 0,
    received: result?.received ?? payload.memories.length,
  };
}

export async function setAutonomyMode(
  client: SupabaseClient,
  mode: AutonomyMode,
): Promise<void> {
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new Error('Sign in again to change company settings.');

  const { error } = await client
    .from('business_settings')
    .update({ autonomy_mode: mode })
    .eq('owner_id', userData.user.id);

  if (error) throw new Error(describeCloudError(error));
}

export async function signInWithPassword(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<CloudResult> {
  const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) return { ok: false, error: describeCloudError(error) };
  return { ok: true };
}

export async function signUpWithPassword(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<CloudResult> {
  const { data, error } = await client.auth.signUp({ email: email.trim(), password });
  if (error) return { ok: false, error: describeCloudError(error) };

  if (!data.session) {
    return {
      ok: true,
      detail: 'Account created. Confirm the email Supabase sent you, then sign in.',
    };
  }

  return { ok: true, detail: 'Account created and signed in.' };
}

async function currentOwnerId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error('Sign in again to continue.');
  return data.user.id;
}

/* -------------------------------------------------------------- Phase 2 */

export async function loadLeads(client: SupabaseClient, limit = 30): Promise<CloudLead[]> {
  const { data, error } = await client
    .from('leads')
    .select(
      'id, business_name, website, domain, industry, location, status, score, research_confidence, recommended_service, recommended_service_key, score_breakdown, discovered_at, qualified_at',
    )
    .order('discovered_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudLead[];
}

export async function loadCatalog(client: SupabaseClient): Promise<CloudCatalogService[]> {
  const { data, error } = await client
    .from('service_catalog')
    .select(
      'id, key, name, description, pricing_model, price_cents, min_price_cents, max_price_cents, delivery_days, revisions, requirements, enabled',
    )
    .order('name', { ascending: true });

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudCatalogService[];
}

/** Prices are set by the owner. Nothing here invents one. */
export async function updateCatalogService(
  client: SupabaseClient,
  id: string,
  patch: {
    price_cents?: number | null;
    delivery_days?: number;
    enabled?: boolean;
  },
): Promise<void> {
  const { error } = await client.from('service_catalog').update(patch).eq('id', id);
  if (error) throw new Error(describeCloudError(error));
}

export async function loadDiscoveryRuns(
  client: SupabaseClient,
  limit = 5,
): Promise<CloudDiscoveryRun[]> {
  const { data, error } = await client
    .from('discovery_runs')
    .select('id, provider, query, status, found, inserted, skipped, error, started_at, finished_at')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudDiscoveryRun[];
}

export async function updateCompanySettings(
  client: SupabaseClient,
  patch: Partial<{
    discovery_enabled: boolean;
    email_enabled: boolean;
    production_enabled: boolean;
    payments_live: boolean;
    stripe_live_mode: boolean;
    daily_lead_cap: number;
    score_threshold: number;
    industries: string[];
    geography: string[];
  }>,
): Promise<void> {
  const ownerId = await currentOwnerId(client);
  const { error } = await client.from('business_settings').update(patch).eq('owner_id', ownerId);
  if (error) throw new Error(describeCloudError(error));
}

/**
 * Queue a discovery run. The idempotency key is bucketed to the minute, so a
 * double tap on a slow connection cannot launch two searches.
 */
export async function enqueueDiscovery(
  client: SupabaseClient,
  query?: string,
): Promise<string | null> {
  const bucket = Math.floor(Date.now() / 60_000);

  const { data, error } = await client.rpc('enqueue_agent_job', {
    p_kind: 'atlas.discover',
    p_payload: query?.trim() ? { query: query.trim() } : {},
    p_idempotency_key: `discover:${bucket}`,
    p_priority: 110,
  });

  if (error) throw new Error(describeCloudError(error));

  const job = data as { id?: string } | null;
  return job?.id ?? null;
}

/* -------------------------------------------------------------- Phase 3 */

export async function loadOutreachMessages(
  client: SupabaseClient,
  limit = 40,
): Promise<CloudOutreachMessage[]> {
  const { data, error } = await client
    .from('outreach_messages')
    .select(
      'id, lead_id, to_email, to_name, subject, body, status, created_at, approved_at, sent_at, failed_reason',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudOutreachMessage[];
}

export async function loadEmailAccount(client: SupabaseClient): Promise<CloudEmailAccount | null> {
  const { data, error } = await client
    .from('email_accounts')
    .select('provider, from_name, from_email, inbox_id, verified, enabled')
    .maybeSingle();

  if (error) throw new Error(describeCloudError(error));
  return (data as CloudEmailAccount | null) ?? null;
}

/**
 * Approve a draft. The database performs the transition: only a draft can become
 * approved, and a suppressed address is refused inside the function.
 */
export async function approveOutreachMessage(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.rpc('approve_outreach_message', { p_id: id });
  if (error) throw new Error(describeCloudError(error));
}

/** Queue a draft for one lead. The worker writes the text from stored facts. */
export async function enqueueDraft(
  client: SupabaseClient,
  leadId: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('enqueue_agent_job', {
    p_kind: 'echo.draft_email',
    p_payload: { leadId },
    p_idempotency_key: `draft:${leadId}`,
    p_priority: 140,
  });

  if (error) throw new Error(describeCloudError(error));

  const job = data as { id?: string } | null;
  return job?.id ?? null;
}

export interface ReadyLeadPage {
  leads: CloudReadyLead[];
  total: number;
}

/**
 * One page of leads that can be drafted now, decided by the database.
 *
 * `total` is the size of the whole matching set, so the screen can say that more
 * exist and page through them instead of stopping at the first page.
 */
export async function loadReadyLeads(
  client: SupabaseClient,
  limit = 100,
  offset = 0,
): Promise<ReadyLeadPage> {
  const { data, error } = await client.rpc('ready_to_draft_leads', {
    p_limit: limit,
    p_offset: offset,
  });

  if (error) throw new Error(describeCloudError(error));

  const rows = (data ?? []) as (CloudReadyLead & { total_count: number | string })[];
  const total = rows.length > 0 ? Number(rows[0].total_count) : offset;

  return { leads: rows, total: Number.isFinite(total) ? total : rows.length };
}

/** How many leads are ready, and how many are waiting on a usable address. */
export async function loadReadyStats(
  client: SupabaseClient,
): Promise<{ ready: number; withoutContact: number }> {
  const { data, error } = await client.rpc('ready_to_draft_stats');
  if (error) throw new Error(describeCloudError(error));

  const row = (Array.isArray(data) ? data[0] : data) as
    | { ready?: number | string; without_contact?: number | string }
    | null;

  return {
    ready: Number(row?.ready ?? 0),
    withoutContact: Number(row?.without_contact ?? 0),
  };
}

/* -------------------------------------------------------------- Phase 4 */

export async function loadQuotes(client: SupabaseClient, limit = 40): Promise<CloudQuote[]> {
  const { data, error } = await client
    .from('quotes')
    .select(
      'id, lead_id, deal_id, service_key, title, scope, deliverables, terms, requirements, discount_cents, amount_cents, currency, status, delivery_days, expires_at, sent_at, accepted_at, accepted_via, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudQuote[];
}

/**
 * Create a draft quote. The owner writes the amount; nothing here guesses one.
 * The row is created as a draft, and only send_quote can release it.
 */
export async function createQuote(
  client: SupabaseClient,
  input: {
    leadId: string;
    title: string;
    scope: string;
    deliverables?: string;
    terms?: string;
    requirements?: string[];
    discountCents?: number;
    amountCents: number;
    deliveryDays: number;
    expiresInDays: number;
  },
): Promise<string> {
  const ownerId = await currentOwnerId(client);

  const expiresAt = new Date(
    Date.now() + Math.max(1, Math.min(60, input.expiresInDays)) * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await client
    .from('quotes')
    .insert({
      owner_id: ownerId,
      lead_id: input.leadId,
      title: input.title.trim().slice(0, 160),
      scope: input.scope.trim().slice(0, 2000),
      deliverables: (input.deliverables ?? '').trim().slice(0, 2000),
      terms: (input.terms ?? '').trim().slice(0, 2000),
      requirements: (input.requirements ?? []).slice(0, 12).map((item) => item.trim()).filter(Boolean),
      discount_cents: Math.max(0, Math.round(input.discountCents ?? 0)),
      amount_cents: Math.max(1, Math.round(input.amountCents)),
      delivery_days: Math.max(1, Math.min(90, Math.round(input.deliveryDays))),
      expires_at: expiresAt,
      status: 'draft',
    })
    .select('id')
    .single();

  if (error) throw new Error(describeCloudError(error));

  const row = data as { id?: string } | null;
  if (!row?.id) throw new Error('The quote was not stored.');
  return row.id;
}

/** Release a draft quote. The database refuses an expired draft. */
export async function sendQuote(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('send_quote', { p_quote_id: id });
  if (error) throw new Error(describeCloudError(error));
}

/** Mint the signed acceptance link. The signature is made server-side only. */
export async function mintQuoteLink(
  client: SupabaseClient,
  quoteId: string,
): Promise<{ url: string; expiresAt: string }> {
  const { data, error } = await client.functions.invoke('quote', {
    body: { action: 'link', quoteId },
  });

  if (error) throw new Error(describeCloudError(error));

  const payload = data as { ok?: boolean; url?: string; expires_at?: string; error?: string } | null;
  if (!payload?.ok || !payload.url) {
    throw new Error(payload?.error ?? 'The link was not created.');
  }

  return { url: payload.url, expiresAt: payload.expires_at ?? '' };
}

export async function loadPaymentIntents(
  client: SupabaseClient,
  limit = 20,
): Promise<CloudPaymentIntent[]> {
  const { data, error } = await client
    .from('payment_intents')
    .select(
      'id, quote_id, amount_cents, currency, provider, status, checkout_url, checkout_session_id, paid_at, refunded_cents, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudPaymentIntent[];
}

/**
 * Open a Stripe Checkout Session for an accepted quote.
 *
 * Only the quote id leaves the phone. The Stripe secret key stays in the edge
 * function, and the function refuses anything the database has not accepted.
 */
export async function createCheckout(
  client: SupabaseClient,
  quoteId: string,
): Promise<{ url: string; mode: 'test' | 'live'; reused: boolean }> {
  const { data, error } = await client.functions.invoke('payments', {
    body: { quoteId },
  });

  if (error) throw new Error(describeCloudError(error));

  const payload = data as
    | { ok?: boolean; url?: string; mode?: string; reused?: boolean; error?: string }
    | null;

  if (!payload?.ok || !payload.url) {
    throw new Error(payload?.error ?? 'Stripe did not return a checkout link.');
  }

  return {
    url: payload.url,
    mode: payload.mode === 'live' ? 'live' : 'test',
    reused: payload.reused === true,
  };
}

/** Paid orders. An order exists only for a payment Stripe confirmed. */
export async function loadOrders(client: SupabaseClient, limit = 40): Promise<CloudOrder[]> {
  const { data, error } = await client
    .from('orders')
    .select(
      'id, quote_id, payment_intent_id, lead_id, amount_cents, currency, status, paid_at, created_at',
    )
    .order('paid_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudOrder[];
}

/** Revenue, refunds, pending money, costs and profit, computed by the database. */
export async function loadFinanceSummary(
  client: SupabaseClient,
): Promise<CloudFinanceSummary | null> {
  const { data, error } = await client.rpc('finance_summary');
  if (error) throw new Error(describeCloudError(error));
  if (!data) return null;

  const raw = data as Record<string, unknown>;
  const number = (key: string): number => {
    const value = Number(raw[key]);
    return Number.isFinite(value) ? value : 0;
  };

  return {
    grossRevenueCents: number('grossRevenueCents'),
    netRevenueCents: number('netRevenueCents'),
    refundedCents: number('refundedCents'),
    pendingCents: number('pendingCents'),
    expensesCents: number('expensesCents'),
    aiSpendCents: number('aiSpendCents'),
    profitCents: number('profitCents'),
    pendingCount: number('pendingCount'),
    paidCount: number('paidCount'),
    failedCount: number('failedCount'),
    orderCount: number('orderCount'),
    paymentsLive: raw.paymentsLive === true,
    stripeLiveMode: raw.stripeLiveMode === true,
  };
}

export async function loadExpenses(client: SupabaseClient, limit = 40): Promise<CloudExpense[]> {
  const { data, error } = await client
    .from('expenses')
    .select('id, category, note, amount_cents, incurred_on, created_at')
    .order('incurred_on', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudExpense[];
}

/** The owner records a real cost; nothing here estimates one. */
export async function addExpense(
  client: SupabaseClient,
  input: { category: CloudExpense['category']; note: string; amountCents: number },
): Promise<void> {
  const ownerId = await currentOwnerId(client);

  const { error } = await client.from('expenses').insert({
    owner_id: ownerId,
    category: input.category,
    note: input.note.trim().slice(0, 200),
    amount_cents: Math.max(1, Math.round(input.amountCents)),
  });

  if (error) throw new Error(describeCloudError(error));
}

export async function deleteExpense(client: SupabaseClient, id: string): Promise<void> {
  const ownerId = await currentOwnerId(client);
  const { error } = await client.from('expenses').delete().eq('id', id).eq('owner_id', ownerId);
  if (error) throw new Error(describeCloudError(error));
}

/** Queue the internal "amount owed" record for an accepted quote. Nothing charges. */
export async function enqueuePaymentIntent(
  client: SupabaseClient,
  quoteId: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('enqueue_agent_job', {
    p_kind: 'relay.create_payment_intent',
    p_payload: { quoteId },
    p_idempotency_key: `intent:${quoteId}`,
    p_priority: 160,
  });

  if (error) throw new Error(describeCloudError(error));

  const job = data as { id?: string } | null;
  return job?.id ?? null;
}

/* -------------------------------------------------------------- Phase 5 */

export async function loadDeals(client: SupabaseClient, limit = 60): Promise<CloudDeal[]> {
  const { data, error } = await client
    .from('deals')
    .select('id, lead_id, contact_id, stage, service_key, price_cents, currency, scope, next_action, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudDeal[];
}

export async function loadReplies(client: SupabaseClient, limit = 20): Promise<CloudReply[]> {
  const { data, error } = await client
    .from('email_events')
    .select('id, message_id, kind, intent, detail, created_at')
    .in('kind', ['replied', 'unsubscribed', 'bounced', 'complained'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudReply[];
}

/** A manual stage change is the owner's own judgement, never an inferred outcome. */
export async function setDealStage(
  client: SupabaseClient,
  id: string,
  stage: DealStage,
): Promise<void> {
  const ownerId = await currentOwnerId(client);
  const { error } = await client
    .from('deals')
    .update({ stage })
    .eq('id', id)
    .eq('owner_id', ownerId);

  if (error) throw new Error(describeCloudError(error));
}

/* -------------------------------------------------------------- Phase 6 */

export async function loadDeliverables(
  client: SupabaseClient,
  limit = 40,
): Promise<CloudDeliverable[]> {
  const { data, error } = await client
    .from('deliverables')
    .select(
      'id, quote_id, deal_id, lead_id, title, scope, status, due_at, started_at, delivered_at, accepted_at, revisions_included, revisions_used, artifact_url, revision_note, delivery_message_id, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudDeliverable[];
}

/** An accepted quote becomes tracked work. The database refuses anything else. */
export async function openDelivery(client: SupabaseClient, quoteId: string): Promise<void> {
  const { error } = await client.rpc('open_delivery', { p_quote_id: quoteId });
  if (error) throw new Error(describeCloudError(error));
}

export async function startDeliverable(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('start_deliverable', { p_id: id });
  if (error) throw new Error(describeCloudError(error));
}

/** The URL is the evidence; the database rejects a delivery without one. */
export async function markDeliverableDelivered(
  client: SupabaseClient,
  id: string,
  artifactUrl: string,
): Promise<void> {
  const { error } = await client.rpc('mark_deliverable_delivered', {
    p_id: id,
    p_artifact_url: artifactUrl,
  });
  if (error) throw new Error(describeCloudError(error));
}

export async function acceptDeliverable(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('accept_deliverable', { p_id: id });
  if (error) throw new Error(describeCloudError(error));
}

export async function requestDeliverableRevision(
  client: SupabaseClient,
  id: string,
  note: string,
): Promise<void> {
  const { error } = await client.rpc('request_deliverable_revision', { p_id: id, p_note: note });
  if (error) throw new Error(describeCloudError(error));
}

/** Mint a private, expiring link to the stored files. The token is returned once. */
export async function mintDeliveryLink(
  client: SupabaseClient,
  deliverableId: string,
  days = 14,
): Promise<{ url: string; expiresAt: string }> {
  const { data, error } = await client.functions.invoke('delivery', {
    body: { action: 'mint', deliverableId, days },
  });

  if (error) throw new Error(describeCloudError(error));

  const payload = data as { ok?: boolean; url?: string; expiresAt?: string; error?: string } | null;
  if (!payload?.ok || !payload.url) {
    throw new Error(payload?.error ?? 'The delivery link was not created.');
  }

  return { url: payload.url, expiresAt: payload.expiresAt ?? '' };
}

/** Queue the transactional delivery email. It is marked delivered only after a real send. */
export async function enqueueDeliveryEmail(
  client: SupabaseClient,
  deliverableId: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('enqueue_agent_job', {
    p_kind: 'relay.send_delivery',
    p_payload: { deliverableId },
    p_idempotency_key: `delivery-email:${deliverableId}`,
    p_priority: 140,
  });

  if (error) throw new Error(describeCloudError(error));

  const job = data as { id?: string } | null;
  return job?.id ?? null;
}

export async function loadCustomerHistory(
  client: SupabaseClient,
  limit = 50,
): Promise<CloudCustomerHistory[]> {
  const { data, error } = await client.rpc('customer_history', { p_limit: limit });
  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudCustomerHistory[];
}

/* -------------------------------------------------------------- Phase 3 follow-ups */

export async function loadFollowUps(
  client: SupabaseClient,
  limit = 30,
): Promise<CloudFollowUp[]> {
  const { data, error } = await client
    .from('follow_ups')
    .select('id, message_id, lead_id, contact_id, kind, status, due_at, note, draft_message_id, created_at')
    .order('due_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudFollowUp[];
}

/** The database refuses a follow-up for a message that was never sent. */
export async function scheduleFollowUp(
  client: SupabaseClient,
  messageId: string,
  dueAt: string,
  note?: string,
  kind: 'follow_up' | 'retention' = 'follow_up',
): Promise<void> {
  const { error } = await client.rpc('schedule_follow_up', {
    p_message_id: messageId,
    p_due_at: dueAt,
    p_note: note ?? null,
    p_kind: kind,
  });

  if (error) throw new Error(describeCloudError(error));
}

export async function cancelFollowUp(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('cancel_follow_up', { p_id: id });
  if (error) throw new Error(describeCloudError(error));
}

/* -------------------------------------------------------------- Phase 6 studio */

export async function loadProductionJobs(
  client: SupabaseClient,
  limit = 40,
): Promise<CloudProductionJob[]> {
  const { data, error } = await client
    .from('production_jobs')
    .select(
      'id, order_id, quote_id, service_key, title, status, attempts, max_attempts, version, qa_notes, started_at, finished_at, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudProductionJob[];
}

export async function loadProductionFiles(
  client: SupabaseClient,
  limit = 200,
): Promise<CloudProductionFile[]> {
  const { data, error } = await client
    .from('production_files')
    .select('id, job_id, version, name, mime, bytes, kind, storage_path, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudProductionFile[];
}

export async function loadProductionQa(
  client: SupabaseClient,
  limit = 60,
): Promise<CloudProductionQa[]> {
  const { data, error } = await client
    .from('production_qa')
    .select('id, job_id, version, verdict, checks, notes, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(describeCloudError(error));
  return (data ?? []) as CloudProductionQa[];
}

/** Start or retry one job. The database refuses a job that is not queued. */
export async function startProduction(client: SupabaseClient, jobId: string): Promise<void> {
  const { error } = await client.rpc('start_production', { p_job_id: jobId });
  if (error) throw new Error(describeCloudError(error));
}

/**
 * A short-lived signed link to one stored file. The bucket is private and the
 * storage policy only lets the owner read their own folder.
 */
export async function productionFileUrl(
  client: SupabaseClient,
  storagePath: string,
  seconds = 3600,
): Promise<string> {
  const { data, error } = await client.storage
    .from('deliverables')
    .createSignedUrl(storagePath, seconds);

  if (error) throw new Error(describeCloudError(error));
  if (!data?.signedUrl) throw new Error('No download link was created.');
  return data.signedUrl;
}
