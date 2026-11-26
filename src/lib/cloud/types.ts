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

/* -------------------------------------------------------------- Phase 4 */

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

export interface CloudQuote {
  id: string;
  lead_id: string | null;
  deal_id: string | null;
  service_key: string | null;
  title: string;
  scope: string;
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
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CloudPaymentIntent {
  id: string;
  quote_id: string;
  amount_cents: number;
  currency: string;
  provider: 'none' | 'stripe';
  status: PaymentIntentStatus;
  created_at: string;
}

export const PAYMENT_STATUS_LABEL: Record<PaymentIntentStatus, string> = {
  requires_payment: 'OWED',
  pending: 'PENDING',
  succeeded: 'PAID',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
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

export const AUTONOMY_MODES: { key: AutonomyMode; label: string; note: string }[] = [
  { key: 'paused', label: 'Paused', note: 'Nothing runs except recovery jobs.' },
  { key: 'intelligence', label: 'Intelligence', note: 'Discover, research, score and draft only.' },
  { key: 'outreach', label: 'Outreach', note: 'Adds limited email and inbox monitoring.' },
  { key: 'sales', label: 'Sales', note: 'Adds reply handling and approved quotes.' },
  { key: 'revenue', label: 'Revenue', note: 'Adds checkout and verified payments.' },
  { key: 'full', label: 'Full', note: 'Adds production, QA, delivery and retention.' },
];
