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

export const AUTONOMY_MODES: { key: AutonomyMode; label: string; note: string }[] = [
  { key: 'paused', label: 'Paused', note: 'Nothing runs except recovery jobs.' },
  { key: 'intelligence', label: 'Intelligence', note: 'Discover, research, score and draft only.' },
  { key: 'outreach', label: 'Outreach', note: 'Adds limited email and inbox monitoring.' },
  { key: 'sales', label: 'Sales', note: 'Adds reply handling and approved quotes.' },
  { key: 'revenue', label: 'Revenue', note: 'Adds checkout and verified payments.' },
  { key: 'full', label: 'Full', note: 'Adds production, QA, delivery and retention.' },
];
