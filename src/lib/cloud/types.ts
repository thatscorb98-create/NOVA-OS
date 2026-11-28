/** Shapes returned by the Phase 1 cloud schema and RPCs. */

export type AutonomyMode =
  | 'paused'
  | 'intelligence'
  | 'outreach'
  | 'sales'
  | 'revenue'
  | 'full';

export type CloudJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead'
  | 'cancelled';

export interface CloudQueueStats {
  queued: number;
  running: number;
  failed: number;
  dead: number;
  succeeded24h: number;
}

export interface CloudWorkerStatus {
  worker_id: string;
  status: 'idle' | 'working' | 'error';
  version: string | null;
  last_seen_at: string;
  alive: boolean;
}

export interface CloudSettings {
  autonomy_mode: AutonomyMode;
  company_name: string;
  discovery_enabled: boolean;
  industries: string[];
  geography: string[];
  daily_lead_cap: number;
  daily_email_cap: number;
  max_concurrency: number;
  score_threshold: number;
  ai_budget_cents: number;
  ai_spend_cents: number;
  email_enabled: boolean;
  production_enabled: boolean;
  payments_live: boolean;
  updated_at: string;
}

export interface CloudCounts {
  leads: number;
  deals: number;
  memories: number;
  events24h: number;
}

export interface CloudHealth {
  ok: boolean;
  owner_id: string;
  phase: string;
  queue: CloudQueueStats;
  worker: CloudWorkerStatus | null;
  settings: CloudSettings | null;
  counts: CloudCounts;
  checked_at: string;
}

export interface CloudJob {
  id: string;
  kind: string;
  status: CloudJobStatus;
  attempts: number;
  max_attempts: number;
  created_at: string;
  finished_at: string | null;
  last_error: string | null;
}

export interface CloudEvent {
  id: number;
  kind: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  created_at: string;
}

export interface CloudResult {
  ok: boolean;
  error?: string;
  detail?: string;
}

export type LeadStatus = 'discovered' | 'researched' | 'qualified' | 'rejected' | 'archived';

export interface CloudLead {
  id: string;
  business_name: string;
  website: string | null;
  domain: string | null;
  industry: string | null;
  location: string | null;
  status: LeadStatus;
  score: number | null;
  research_confidence: number | null;
  recommended_service: string | null;
  recommended_service_key: string | null;
  score_breakdown: Record<string, unknown> | null;
  discovered_at: string;
  qualified_at: string | null;
}

export interface CloudCatalogService {
  id: string;
  key: string;
  name: string;
  description: string;
  pricing_model: 'fixed' | 'range';
  price_cents: number | null;
  min_price_cents: number | null;
  max_price_cents: number | null;
  delivery_days: number;
  revisions: number;
  requirements: string[];
  enabled: boolean;
}

export interface CloudDiscoveryRun {
  id: string;
  provider: string;
  query: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  found: number;
  inserted: number;
  skipped: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface CloudCompanySettings {
  autonomy_mode: AutonomyMode;
  discovery_enabled: boolean;
  email_enabled: boolean;
  production_enabled: boolean;
  payments_live: boolean;
  daily_lead_cap: number;
  daily_email_cap: number;
  score_threshold: number;
  industries: string[];
  geography: string[];
}

export type OutreachStatus =
  | 'draft'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'bounced'
  | 'replied'
  | 'cancelled';

export interface CloudOutreachMessage {
  id: string;
  lead_id: string | null;
  to_email: string;
  to_name: string | null;
  subject: string;
  body: string;
  status: OutreachStatus;
  created_at: string;
  approved_at: string | null;
  sent_at: string | null;
  failed_reason: string | null;
}

export interface CloudEmailAccount {
  provider: string;
  from_name: string | null;
  from_email: string | null;
  inbox_id: string | null;
  verified: boolean;
  enabled: boolean;
}

export const OUTREACH_STATUS_LABEL: Record<OutreachStatus, string> = {
  draft: 'DRAFT',
  approved: 'APPROVED',
  sending: 'SENDING',
  sent: 'SENT',
  failed: 'FAILED',
  bounced: 'BOUNCED',
  replied: 'REPLIED',
  cancelled: 'CANCELLED',
};

export interface CloudContact {
  id: string;
  lead_id: string | null;
  name: string | null;
  email: string | null;
  email_normalized: string | null;
  verified: boolean;
  opted_out: boolean;
}

/**
 * A lead that can be drafted now, with the one address we would write to.
 *
 * Returned by `ready_to_draft_leads`, so the decision sees every contact the
 * owner has instead of only the first page the app loaded.
 */
export interface CloudReadyLead extends CloudLead {
  contact_id: string | null;
  contact_email: string | null;
}

/* -------------------------------------------------------------- Phase 4 */

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

export interface CloudQuote {
  id: string;
  lead_id: string | null;
  deal_id: string | null;
  service_key: string | null;
  title: string;
  scope: string;
  deliverables: string;
  terms: string;
  requirements: string[];
  discount_cents: number;
  amount_cents: number;
  currency: string;
  status: QuoteStatus;
  delivery_days: number;
  expires_at: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_via: 'link' | 'email' | 'manual' | null;
  created_at: string;
}

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: 'DRAFT',
  sent: 'WAITING',
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  expired: 'EXPIRED',
};

export type PaymentIntentStatus =
  | 'requires_payment'
  | 'checkout_created'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

export interface CloudPaymentIntent {
  id: string;
  quote_id: string;
  amount_cents: number;
  currency: string;
  provider: 'none' | 'stripe';
  status: PaymentIntentStatus;
  checkout_url: string | null;
  checkout_session_id: string | null;
  paid_at: string | null;
  refunded_cents: number;
  created_at: string;
}

export const PAYMENT_STATUS_LABEL: Record<PaymentIntentStatus, string> = {
  requires_payment: 'AWAITING CHECKOUT',
  checkout_created: 'CHECKOUT OPEN',
  pending: 'PENDING',
  succeeded: 'PAID',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  refunded: 'REFUNDED',
  partially_refunded: 'PART REFUNDED',
};

/** A paid order exists only after Stripe's signed webhook confirmed the money. */
export interface CloudOrder {
  id: string;
  quote_id: string;
  payment_intent_id: string;
  lead_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'paid' | 'fulfilled' | 'refunded' | 'partially_refunded';
  paid_at: string;
  created_at: string;
}

export const ORDER_STATUS_LABEL: Record<CloudOrder['status'], string> = {
  paid: 'PAID',
  fulfilled: 'FULFILLED',
  refunded: 'REFUNDED',
  partially_refunded: 'PART REFUNDED',
};

export interface CloudFinanceSummary {
  grossRevenueCents: number;
  netRevenueCents: number;
  refundedCents: number;
  pendingCents: number;
  expensesCents: number;
  aiSpendCents: number;
  profitCents: number;
  pendingCount: number;
  paidCount: number;
  failedCount: number;
  orderCount: number;
  paymentsLive: boolean;
  stripeLiveMode: boolean;
}

export type ExpenseCategory = 'software' | 'ads' | 'contractor' | 'tools' | 'other';

export interface CloudExpense {
  id: string;
  category: ExpenseCategory;
  note: string;
  amount_cents: number;
  incurred_on: string;
  created_at: string;
}

export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  software: 'SOFTWARE',
  ads: 'ADS',
  contractor: 'CONTRACTOR',
  tools: 'TOOLS',
  other: 'OTHER',
};

/* -------------------------------------------------------------- Phase 5 */

export type DealStage =
  | 'discovered'
  | 'researched'
  | 'qualified'
  | 'contacted'
  | 'replied'
  | 'interested'
  | 'offer_prepared'
  | 'negotiating'
  | 'ready_to_purchase'
  | 'won'
  | 'lost'
  | 'do_not_contact';

export interface CloudDeal {
  id: string;
  lead_id: string | null;
  contact_id: string | null;
  stage: DealStage;
  service_key: string | null;
  price_cents: number | null;
  currency: string;
  scope: string | null;
  next_action: string | null;
  updated_at: string;
}

export type ReplyIntent = 'interested' | 'question' | 'not_interested' | 'unsubscribe' | 'other';

export interface CloudReply {
  id: number;
  message_id: string | null;
  kind: string;
  intent: ReplyIntent | null;
  detail: string | null;
  created_at: string;
}

export const REPLY_INTENT_LABEL: Record<ReplyIntent, string> = {
  interested: 'INTERESTED',
  question: 'QUESTION',
  not_interested: 'NOT INTERESTED',
  unsubscribe: 'OPTED OUT',
  other: 'REPLY',
};

export const DEAL_STAGE_LABEL: Record<DealStage, string> = {
  discovered: 'DISCOVERED',
  researched: 'RESEARCHED',
  qualified: 'QUALIFIED',
  contacted: 'CONTACTED',
  replied: 'REPLIED',
  interested: 'INTERESTED',
  offer_prepared: 'OFFER PREPARED',
  negotiating: 'NEGOTIATING',
  ready_to_purchase: 'READY TO BUY',
  won: 'WON',
  lost: 'LOST',
  do_not_contact: 'DO NOT CONTACT',
};

/* -------------------------------------------------------------- Phase 6 */

export type DeliverableStatus =
  | 'pending'
  | 'in_progress'
  | 'delivered'
  | 'accepted'
  | 'revision_requested'
  | 'cancelled';

export interface CloudDeliverable {
  id: string;
  quote_id: string;
  deal_id: string | null;
  lead_id: string | null;
  title: string;
  scope: string;
  status: DeliverableStatus;
  due_at: string | null;
  started_at: string | null;
  delivered_at: string | null;
  accepted_at: string | null;
  revisions_included: number;
  revisions_used: number;
  artifact_url: string | null;
  revision_note: string | null;
  delivery_message_id: string | null;
  created_at: string;
}

export interface CloudDeliveryLink {
  id: string;
  deliverable_id: string;
  expires_at: string;
  revoked_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

export interface CloudCustomerHistory {
  lead_id: string;
  business_name: string;
  orders_count: number;
  paid_cents: number;
  deliverables_count: number;
  accepted_count: number;
  last_delivered_at: string | null;
}

export const DELIVERABLE_STATUS_LABEL: Record<DeliverableStatus, string> = {
  pending: 'NOT STARTED',
  in_progress: 'IN PROGRESS',
  delivered: 'DELIVERED',
  accepted: 'ACCEPTED',
  revision_requested: 'REVISION ASKED',
  cancelled: 'CANCELLED',
};

/* -------------------------------------------------------------- Phase 3 */

export type FollowUpStatus = 'scheduled' | 'drafted' | 'sent' | 'cancelled' | 'skipped';

export interface CloudFollowUp {
  id: string;
  message_id: string;
  lead_id: string | null;
  contact_id: string | null;
  kind: 'follow_up' | 'retention';
  status: FollowUpStatus;
  due_at: string;
  note: string | null;
  draft_message_id: string | null;
  created_at: string;
}

export const FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatus, string> = {
  scheduled: 'SCHEDULED',
  drafted: 'DRAFTED',
  sent: 'SENT',
  cancelled: 'CANCELLED',
  skipped: 'SKIPPED',
};

/* -------------------------------------------------------------- Phase 8 loop */

export type CompanyCycleStatus = 'action' | 'idle' | 'paused' | 'blocked' | 'error';

export interface CloudCompanyCycle {
  id: string;
  cycle_key: string;
  status: CompanyCycleStatus;
  decision: string;
  detail: Record<string, unknown>;
  job_id: string | null;
  created_at: string;
}

export interface CloudLoopSnapshot {
  mode: AutonomyMode;
  emailEnabled: boolean;
  discoveryEnabled: boolean;
  productionEnabled: boolean;
  dailyLeadCap: number;
  dailyEmailCap: number;
  aiBudgetCents: number;
  aiSpendCents: number;
  aiRemainingCents: number;
  counts: {
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
    jobsQueued: number;
    jobsDead: number;
    ordersPaid: number;
  };
  next: {
    followUpId: string | null;
    replyEventId: number | null;
    production: { jobId: string; version: number } | null;
    delivery: { jobId: string; deliverableId: string } | null;
    approvedMessageId: string | null;
    leadId: string | null;
    deliveredMessageId: string | null;
  };
  serverTime: string;
}

/* -------------------------------------------------------------- Phase 6 studio */

export type ProductionStatus =
  | 'queued'
  | 'generating'
  | 'qa'
  | 'ready'
  | 'needs_attention'
  | 'delivered'
  | 'cancelled';

export interface CloudProductionJob {
  id: string;
  order_id: string;
  quote_id: string;
  service_key: string | null;
  title: string;
  status: ProductionStatus;
  attempts: number;
  max_attempts: number;
  version: number;
  qa_notes: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface CloudProductionFile {
  id: string;
  job_id: string;
  version: number;
  name: string;
  mime: string;
  bytes: number;
  kind: 'primary' | 'preview' | 'asset';
  storage_path: string;
  created_at: string;
}

export interface CloudProductionQa {
  id: number;
  job_id: string;
  version: number;
  verdict: 'pass' | 'fail';
  checks: { name: string; pass: boolean; detail: string }[];
  notes: string | null;
  created_at: string;
}

export const PRODUCTION_STATUS_LABEL: Record<ProductionStatus, string> = {
  queued: 'QUEUED',
  generating: 'GENERATING',
  qa: 'IN QA',
  ready: 'READY',
  needs_attention: 'NEEDS ATTENTION',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
};

export const AUTONOMY_MODES: { key: AutonomyMode; label: string; note: string }[] = [
  { key: 'paused', label: 'Paused', note: 'Nothing runs except recovery jobs.' },
  { key: 'intelligence', label: 'Intelligence', note: 'Discover, research, score and draft only.' },
  { key: 'outreach', label: 'Outreach', note: 'Adds limited email and inbox monitoring.' },
  { key: 'sales', label: 'Sales', note: 'Adds reply handling and approved quotes.' },
  { key: 'revenue', label: 'Revenue', note: 'Adds checkout and verified payments.' },
  { key: 'full', label: 'Full', note: 'Adds production, QA, delivery and retention.' },
];
