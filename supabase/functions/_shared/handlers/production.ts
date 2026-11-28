import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type { JobContext, JobHandler } from '../jobs.ts';
import { inspectFiles, type QaFile } from '../production/qa.ts';
import {
  generateProductionFiles,
  type ProductionBrief,
  type WebsiteObservation,
} from '../production/templates.ts';

/**
 * Phase 6 handlers.
 *
 *   forge.produce → generate real files, upload them, hand off to QA
 *   sentinel.qa   → check the stored files; pass, or return to production
 *
 * The app can never mark a production job ready. A pass exists only as a
 * production_qa row written here after the files were downloaded and checked.
 * Retries are bounded by production_jobs.max_attempts.
 */

interface ProductionJobRow {
  id: string;
  owner_id: string;
  order_id: string;
  quote_id: string;
  service_key: string | null;
  title: string;
  status: string;
  attempts: number;
  max_attempts: number;
  version: number;
  qa_notes: string | null;
  brief: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
}

interface QuoteRow {
  title: string;
  scope: string;
  deliverables: string;
  terms: string;
  requirements: string[] | null;
  service_key: string | null;
  lead_id: string | null;
}

interface LeadRow {
  business_name: string;
  website: string | null;
  location: string | null;
  industry: string | null;
}

interface OrderRow {
  lead_id: string | null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function loadJob(
  admin: SupabaseClient,
  ownerId: string,
  jobId: string,
): Promise<ProductionJobRow | null> {
  const { data, error } = await admin
    .from('production_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (error) throw new Error(`Could not read the production job: ${error.message}`);
  return (data as ProductionJobRow | null) ?? null;
}

async function briefFor(
  admin: SupabaseClient,
  job: ProductionJobRow,
): Promise<ProductionBrief> {
  const { data: quoteData, error: quoteError } = await admin
    .from('quotes')
    .select('title, scope, deliverables, terms, requirements, service_key, lead_id')
    .eq('id', job.quote_id)
    .maybeSingle();

  if (quoteError) throw new Error(`Could not read the quote: ${quoteError.message}`);
  const quote = quoteData as QuoteRow | null;

  const { data: orderData } = await admin
    .from('orders')
    .select('lead_id')
    .eq('id', job.order_id)
    .maybeSingle();

  const order = orderData as OrderRow | null;
  let lead: LeadRow | null = null;

  if (order?.lead_id) {
    const { data: leadData } = await admin
      .from('leads')
      .select('business_name, website, location, industry')
      .eq('id', order.lead_id)
      .maybeSingle();
    lead = (leadData as LeadRow | null) ?? null;
  }

  const snapshot = job.brief ?? {};

  return {
    jobId: job.id,
    title: text(snapshot.title, quote?.title ?? job.title),
    serviceKey: text(snapshot.serviceKey, quote?.service_key ?? job.service_key ?? ''),
    businessName: text(snapshot.businessName, lead?.business_name ?? ''),
    website: text(snapshot.website, lead?.website ?? ''),
    location: text(snapshot.location, lead?.location ?? ''),
    industry: text(snapshot.industry, lead?.industry ?? ''),
    contactEmail: text(snapshot.contactEmail, ''),
    scope: text(snapshot.scope, quote?.scope ?? ''),
    deliverables: text(snapshot.deliverables, quote?.deliverables ?? ''),
    terms: text(snapshot.terms, quote?.terms ?? ''),
    requirements: textArray(snapshot.requirements).length > 0
      ? textArray(snapshot.requirements)
      : textArray(quote?.requirements),
    preparedAt: job.created_at,
  };
}

function observationSummary(observation: WebsiteObservation | null): Record<string, unknown> | null {
  if (!observation) return null;
  return {
    url: observation.url,
    status: observation.status,
    elapsedMs: observation.elapsedMs,
    title: observation.title,
    hasViewport: observation.hasViewport,
    error: observation.error,
  };
}

async function storeFiles(
  admin: SupabaseClient,
  job: ProductionJobRow,
  version: number,
  files: { name: string; mime: string; kind: string; bytes: Uint8Array }[],
): Promise<void> {
  for (const file of files) {
    const path = `${job.owner_id}/${job.id}/v${version}/${file.name}`;
    const blob = new Blob([toArrayBuffer(file.bytes)], { type: file.mime });

    const { error: uploadError } = await admin.storage
      .from('deliverables')
      .upload(path, blob, { contentType: file.mime, upsert: true });

    if (uploadError) {
      throw new Error(`Could not store ${file.name}: ${uploadError.message}`);
    }

    const digest = await sha256Hex(file.bytes);
    const { error: rowError } = await admin.from('production_files').upsert(
      {
        owner_id: job.owner_id,
        job_id: job.id,
        version,
        name: file.name,
        storage_path: path,
        mime: file.mime,
        bytes: file.bytes.byteLength,
        sha256: digest,
        kind: file.kind,
      },
      { onConflict: 'storage_path' },
    );

    if (rowError) {
      throw new Error(`Could not record ${file.name}: ${rowError.message}`);
    }
  }
}

export const forgeProduce: JobHandler = async (ctx: JobContext) => {
  const jobId = typeof ctx.job.payload.jobId === 'string' ? ctx.job.payload.jobId : '';
  if (!jobId) throw new Error('forge.produce needs a jobId.');

  const job = await loadJob(ctx.admin, ctx.job.owner_id, jobId);
  if (!job) throw new Error('That production job no longer exists for this owner.');

  if (['ready', 'delivered', 'cancelled'].includes(job.status)) {
    return { skipped: true, reason: job.status };
  }

  if (job.attempts >= job.max_attempts) {
    await ctx.admin
      .from('production_jobs')
      .update({
        status: 'needs_attention',
        qa_notes: job.qa_notes ?? 'The maximum number of production attempts was reached.',
      })
      .eq('id', job.id);
    return { skipped: true, reason: 'max_attempts' };
  }

  const { data: settings, error: settingsError } = await ctx.admin
    .from('business_settings')
    .select('production_enabled')
    .eq('owner_id', job.owner_id)
    .maybeSingle();

  if (settingsError) throw new Error(`Could not read company settings: ${settingsError.message}`);
  if (!settings?.production_enabled) {
    throw new Error('Production is switched off, so no file was generated.');
  }

  const brief = await briefFor(ctx.admin, job);
  const version = job.version + 1;
  const { files, observation } = await generateProductionFiles(brief);

  if (files.length === 0) {
    throw new Error('The generator produced no files, so nothing was stored.');
  }

  await storeFiles(ctx.admin, job, version, files);

  const { error: updateError } = await ctx.admin
    .from('production_jobs')
    .update({
      status: 'qa',
      version,
      attempts: job.attempts + 1,
      started_at: job.started_at ?? new Date().toISOString(),
      finished_at: null,
      qa_notes: null,
    })
    .eq('id', job.id);

  if (updateError) throw new Error(`Could not move the job to QA: ${updateError.message}`);

  await ctx.admin.rpc('enqueue_agent_job', {
    p_kind: 'sentinel.qa',
    p_payload: { jobId: job.id, version },
    p_idempotency_key: `sentinel:${job.id}:v${version}`,
    p_priority: 50,
    p_owner_id: job.owner_id,
  });

  await ctx.log('info', `FORGE generated ${files.length} file(s) for "${job.title}" (v${version}).`, {
    jobId: job.id,
    version,
    files: files.map((file) => file.name),
    audit: observationSummary(observation),
  });

  return {
    jobId: job.id,
    version,
    status: 'qa',
    files: files.map((file) => ({ name: file.name, mime: file.mime, bytes: file.bytes.byteLength })),
  };
};

export const sentinelQa: JobHandler = async (ctx: JobContext) => {
  const jobId = typeof ctx.job.payload.jobId === 'string' ? ctx.job.payload.jobId : '';
  if (!jobId) throw new Error('sentinel.qa needs a jobId.');

  const job = await loadJob(ctx.admin, ctx.job.owner_id, jobId);
  if (!job) throw new Error('That production job no longer exists for this owner.');

  if (job.status !== 'qa') {
    return { skipped: true, reason: job.status };
  }

  const version =
    typeof ctx.job.payload.version === 'number' ? Math.trunc(ctx.job.payload.version) : job.version;

  const { data: rows, error: filesError } = await ctx.admin
    .from('production_files')
    .select('name, mime, kind, bytes, storage_path')
    .eq('job_id', job.id)
    .eq('version', version);

  if (filesError) throw new Error(`Could not read production files: ${filesError.message}`);

  const stored = rows ?? [];
  if (stored.length === 0) {
    throw new Error('No stored files were found for this version, so QA could not run.');
  }

  const files: QaFile[] = [];
  for (const row of stored) {
    const { data: blob, error: downloadError } = await ctx.admin.storage
      .from('deliverables')
      .download(row.storage_path as string);

    if (downloadError || !blob) {
      throw new Error(`Could not open ${row.name}: ${downloadError?.message ?? 'empty download'}`);
    }

    files.push({
      name: row.name as string,
      mime: row.mime as string,
      kind: row.kind as string,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  }

  const brief = await briefFor(ctx.admin, job);
  const result = inspectFiles(files, brief);

  const { error: qaError } = await ctx.admin.from('production_qa').insert({
    owner_id: job.owner_id,
    job_id: job.id,
    version,
    verdict: result.verdict,
    checks: result.checks,
    notes: result.notes,
  });

  if (qaError) throw new Error(`Could not record the QA verdict: ${qaError.message}`);

  if (result.verdict === 'pass') {
    await ctx.admin
      .from('production_jobs')
      .update({ status: 'ready', finished_at: new Date().toISOString(), qa_notes: null })
      .eq('id', job.id);

    await ctx.log('info', `SENTINEL passed "${job.title}" v${version}.`, {
      jobId: job.id,
      version,
      files: files.length,
    });

    return { verdict: 'pass', jobId: job.id, version, files: files.length };
  }

  if (job.attempts >= job.max_attempts) {
    await ctx.admin
      .from('production_jobs')
      .update({
        status: 'needs_attention',
        qa_notes: result.notes,
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    await ctx.log('error', `SENTINEL failed "${job.title}" v${version}; attempts are exhausted.`, {
      jobId: job.id,
      version,
      notes: result.notes,
    });

    return { verdict: 'fail', needsAttention: true, notes: result.notes };
  }

  await ctx.admin
    .from('production_jobs')
    .update({ status: 'queued', qa_notes: result.notes })
    .eq('id', job.id);

  await ctx.admin.rpc('enqueue_agent_job', {
    p_kind: 'forge.produce',
    p_payload: { jobId: job.id, version: job.version + 1, qaNotes: result.notes },
    p_idempotency_key: `forge:${job.id}:v${job.version + 1}`,
    p_priority: 50,
    p_owner_id: job.owner_id,
  });

  await ctx.log('warn', `SENTINEL returned "${job.title}" v${version} to production.`, {
    jobId: job.id,
    version,
    notes: result.notes,
  });

  return { verdict: 'fail', requeued: true, notes: result.notes };
};
