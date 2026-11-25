import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type { JobContext, JobHandler } from '../jobs.ts';
import { searchBusinesses } from '../providers/search.ts';
import { domainOf, fetchPageEvidence, normalizeUrl } from '../providers/website.ts';
import { scoreLead, type CatalogService } from '../scoring.ts';

/**
 * Phase 2 handlers.
 *
 *   atlas.discover  → search public web results, keep real businesses, dedupe
 *   atlas.research  → fetch one public page, store evidence with timestamps
 *   sterling.score  → deterministic 0–100 score and a catalog recommendation
 *
 * Chain: discover → research:<leadId> → score:<leadId>. Every step is a real
 * request whose output is stored; nothing is inferred when a step fails.
 */

interface SettingsRow {
  discovery_enabled: boolean;
  daily_lead_cap: number;
  industries: string[];
  geography: string[];
  score_threshold: number;
}

const DIRECTORY_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'tiktok.com',
  'yelp.com',
  'tripadvisor.com',
  'yellowpages.com',
  'yell.com',
  'google.com',
  'bing.com',
  'wikipedia.org',
  'reddit.com',
  'pinterest.com',
  'mapquest.com',
  'bbb.org',
  'trustpilot.com',
];

async function loadSettings(admin: SupabaseClient, ownerId: string): Promise<SettingsRow> {
  const { data, error } = await admin
    .from('business_settings')
    .select('discovery_enabled, daily_lead_cap, industries, geography, score_threshold')
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (error) throw new Error(`Could not read business settings: ${error.message}`);
  if (!data) throw new Error('No business settings exist for this owner yet.');

  return data as SettingsRow;
}

/** FNV-1a: a stable short hash for evidence dedupe. Not a security hash. */
function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function businessNameFrom(title: string, domain: string): string {
  const cleaned = title
    .split(/\s+[|\-–—:·]\s+/)[0]
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 2 && cleaned.length <= 120) return cleaned;

  const base = domain.split('.')[0].replace(/[-_]+/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function isDirectory(domain: string): boolean {
  return DIRECTORY_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

export const atlasDiscover: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const settings = await loadSettings(ctx.admin, ownerId);

  if (!settings.discovery_enabled) {
    throw new Error(
      'Discovery is disabled. Turn on discovery in Cloud → Company mode before running a search.',
    );
  }

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count: runToday, error: countError } = await ctx.admin
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .gte('discovered_at', startOfDay.toISOString());

  if (countError) throw new Error(`Could not check the daily lead cap: ${countError.message}`);

  const created = runToday ?? 0;
  const remaining = Math.max(0, settings.daily_lead_cap - created);

  const requestedQuery = typeof ctx.job.payload.query === 'string' ? ctx.job.payload.query.trim() : '';
  const industry = settings.industries[0] ?? 'small business';
  const place = settings.geography[0] ?? '';
  const query =
    requestedQuery || `${industry} ${place} small business services contact`.replace(/\s+/g, ' ').trim();

  const limit = Math.max(1, Math.min(Number(ctx.job.payload.limit) || 10, remaining, 20));

  if (remaining === 0) {
    await ctx.admin.from('discovery_runs').insert({
      owner_id: ownerId,
      job_id: ctx.job.id,
      provider: 'cap',
      query,
      industries: settings.industries,
      geography: settings.geography,
      status: 'skipped',
      found: 0,
      inserted: 0,
      skipped: 0,
      error: `Daily lead cap reached (${settings.daily_lead_cap}).`,
      finished_at: new Date().toISOString(),
    });

    await ctx.log('warn', 'Daily lead cap reached; discovery did not run.');
    return { skipped: true, reason: 'daily_lead_cap', cap: settings.daily_lead_cap };
  }

  const { data: run, error: runError } = await ctx.admin
    .from('discovery_runs')
    .insert({
      owner_id: ownerId,
      job_id: ctx.job.id,
      provider: 'search',
      query,
      industries: settings.industries,
      geography: settings.geography,
      status: 'running',
    })
    .select('id')
    .single();

  if (runError) throw new Error(`Could not open a discovery run: ${runError.message}`);

  let hits;

  try {
    hits = await searchBusinesses(query, limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.admin
      .from('discovery_runs')
      .update({ status: 'failed', error: message.slice(0, 800), finished_at: new Date().toISOString() })
      .eq('id', run.id);
    throw error;
  }

  let inserted = 0;
  let skipped = 0;
  const newLeadIds: string[] = [];

  for (const hit of hits) {
    const url = normalizeUrl(hit.url);
    const domain = domainOf(hit.url);

    if (!url || !domain || isDirectory(domain)) {
      skipped += 1;
      continue;
    }

    const name = businessNameFrom(hit.title, domain);

    const { data: lead, error: insertError } = await ctx.admin
      .from('leads')
      .insert({
        owner_id: ownerId,
        business_name: name,
        website: url.toString(),
        domain,
        industry: settings.industries[0] ?? null,
        location: settings.geography[0] ?? null,
        source_kind: 'search',
        source_url: hit.url,
        status: 'discovered',
      })
      .select('id')
      .single();

    if (insertError) {
      // 23505 = the dedupe index already holds this business.
      if (insertError.code === '23505') {
        skipped += 1;
        continue;
      }
      throw new Error(`Could not store a lead: ${insertError.message}`);
    }

    inserted += 1;
    newLeadIds.push(lead.id as string);

    await ctx.admin.rpc('enqueue_agent_job', {
      p_kind: 'atlas.research',
      p_payload: { leadId: lead.id, snippet: hit.snippet, sourceUrl: hit.url },
      p_idempotency_key: `research:${lead.id}`,
      p_priority: 120,
      p_owner_id: ownerId,
    });
  }

  await ctx.admin
    .from('discovery_runs')
    .update({
      status: 'completed',
      found: hits.length,
      inserted,
      skipped,
      finished_at: new Date().toISOString(),
    })
    .eq('id', run.id);

  await ctx.log('info', `Discovery kept ${inserted} new business(es) from ${hits.length} result(s).`, {
    query,
    inserted,
    skipped,
  });

  return { query, found: hits.length, inserted, skipped, cap: settings.daily_lead_cap, created };
};

export const atlasResearch: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const leadId = typeof ctx.job.payload.leadId === 'string' ? ctx.job.payload.leadId : '';

  if (!leadId) throw new Error('atlas.research needs a leadId.');

  const { data: lead, error } = await ctx.admin
    .from('leads')
    .select('id, business_name, website, domain, source_url')
    .eq('id', leadId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the lead: ${error.message}`);
  if (!lead) throw new Error('That lead no longer exists for this owner.');

  const snippet = typeof ctx.job.payload.snippet === 'string' ? ctx.job.payload.snippet : '';
  const sourceUrl = typeof ctx.job.payload.sourceUrl === 'string' ? ctx.job.payload.sourceUrl : '';
  const now = new Date().toISOString();

  const evidence: {
    source_url: string;
    kind: string;
    title: string | null;
    excerpt: string | null;
    http_status: number | null;
    checksum: string;
    captured_at: string;
  }[] = [];

  if (snippet) {
    evidence.push({
      source_url: sourceUrl || (lead.source_url as string) || 'search',
      kind: 'search',
      title: lead.business_name as string,
      excerpt: snippet,
      http_status: null,
      checksum: `search-${fingerprint(snippet)}`,
      captured_at: now,
    });
  }

  let pageOk = false;

  if (lead.website) {
    const result = await fetchPageEvidence(lead.website as string);

    if (result.ok) {
      pageOk = true;
      const page = result.evidence;

      evidence.push({
        source_url: page.finalUrl,
        kind: 'website',
        title: page.title || (lead.business_name as string),
        excerpt: (page.description || page.text).slice(0, 1200),
        http_status: page.httpStatus,
        checksum: `page-${fingerprint(`${page.title}|${page.description}|${page.text}`)}`,
        captured_at: now,
      });

      await ctx.admin
        .from('leads')
        .update({
          website: page.finalUrl,
          domain: domainOf(page.finalUrl) ?? lead.domain,
          last_researched_at: now,
          status: 'researched',
        })
        .eq('id', leadId)
        .eq('owner_id', ownerId);

      for (const email of page.emails) {
        const { error: contactError } = await ctx.admin.from('contacts').insert({
          owner_id: ownerId,
          lead_id: leadId,
          email,
          email_normalized: email,
          source_url: page.finalUrl,
          verified: false,
        });

        if (contactError && contactError.code !== '23505') {
          await ctx.log('warn', `Could not store a contact: ${contactError.message}`);
        }
      }
    } else {
      evidence.push({
        source_url: lead.website as string,
        kind: 'manual',
        title: lead.business_name as string,
        excerpt: `Website could not be read: ${result.reason}`,
        http_status: result.httpStatus || null,
        checksum: `fail-${fingerprint(result.reason)}`,
        captured_at: now,
      });

      await ctx.admin
        .from('leads')
        .update({ last_researched_at: now })
        .eq('id', leadId)
        .eq('owner_id', ownerId);
    }
  }

  for (const row of evidence) {
    const { error: evidenceError } = await ctx.admin.from('lead_research').insert({
      owner_id: ownerId,
      lead_id: leadId,
      ...row,
    });

    // A repeated checksum means this evidence is already stored.
    if (evidenceError && evidenceError.code !== '23505') {
      await ctx.log('warn', `Could not store evidence: ${evidenceError.message}`);
    }
  }

  await ctx.admin.rpc('enqueue_agent_job', {
    p_kind: 'sterling.score',
    p_payload: { leadId },
    p_idempotency_key: `score:${leadId}`,
    p_priority: 130,
    p_owner_id: ownerId,
  });

  await ctx.log('info', pageOk ? 'Website evidence captured.' : 'Lead researched without page access.', {
    leadId,
    sources: evidence.length,
    pageOk,
  });

  return { leadId, pageOk, sources: evidence.length };
};

export const sterlingScore: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const leadId = typeof ctx.job.payload.leadId === 'string' ? ctx.job.payload.leadId : '';

  if (!leadId) throw new Error('sterling.score needs a leadId.');

  const settings = await loadSettings(ctx.admin, ownerId);

  const { data: lead, error } = await ctx.admin
    .from('leads')
    .select('id, business_name, industry, location, website')
    .eq('id', leadId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the lead: ${error.message}`);
  if (!lead) throw new Error('That lead no longer exists for this owner.');

  const { data: evidenceRows } = await ctx.admin
    .from('lead_research')
    .select('kind, source_url, excerpt, title')
    .eq('lead_id', leadId)
    .order('captured_at', { ascending: false })
    .limit(10);

  const { count: contactCount } = await ctx.admin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId);

  const { data: catalogRows, error: catalogError } = await ctx.admin
    .from('service_catalog')
    .select('key, name, enabled, price_cents, min_price_cents, max_price_cents')
    .eq('owner_id', ownerId);

  if (catalogError) throw new Error(`Could not read the service catalog: ${catalogError.message}`);

  const pageRow = (evidenceRows ?? []).find((row) => row.kind === 'website');
  const page = pageRow
    ? {
        url: pageRow.source_url as string,
        finalUrl: pageRow.source_url as string,
        httpStatus: 200,
        title: (pageRow.title as string) ?? '',
        description: '',
        text: (pageRow.excerpt as string) ?? '',
        emails: [],
        hasHttps: String(pageRow.source_url).startsWith('https://'),
        wordCount: String(pageRow.excerpt ?? '').split(/\s+/).filter(Boolean).length,
      }
    : null;

  const result = scoreLead({
    businessName: lead.business_name as string,
    industry: (lead.industry as string) ?? null,
    location: (lead.location as string) ?? null,
    website: (lead.website as string) ?? null,
    page,
    pageFailure: page ? null : 'No website evidence was captured.',
    evidenceCount: (evidenceRows ?? []).length,
    hasContact: (contactCount ?? 0) > 0,
    industries: settings.industries,
    geography: settings.geography,
    catalog: (catalogRows ?? []) as CatalogService[],
  });

  const qualified = result.score >= settings.score_threshold;
  const now = new Date().toISOString();

  const { error: updateError } = await ctx.admin
    .from('leads')
    .update({
      score: result.score,
      score_breakdown: { ...result.breakdown, reasons: result.reasons },
      research_confidence: result.confidence,
      recommended_service: result.recommendedName,
      recommended_service_key: result.recommendedKey,
      status: qualified ? 'qualified' : 'researched',
      qualified_at: qualified ? now : null,
    })
    .eq('id', leadId)
    .eq('owner_id', ownerId);

  if (updateError) throw new Error(`Could not save the score: ${updateError.message}`);

  const { data: existingDeal } = await ctx.admin
    .from('deals')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('lead_id', leadId)
    .not('stage', 'in', '(won,lost,do_not_contact)')
    .maybeSingle();

  if (!existingDeal) {
    const { error: dealError } = await ctx.admin.from('deals').insert({
      owner_id: ownerId,
      lead_id: leadId,
      stage: qualified ? 'qualified' : 'researched',
      service_key: result.recommendedKey,
      scope: result.recommendedName,
    });

    if (dealError && dealError.code !== '23505') {
      await ctx.log('warn', `Could not open a deal: ${dealError.message}`);
    }
  }

  await ctx.log(
    'info',
    `Scored ${result.score}/100 (${qualified ? 'qualified' : 'not qualified'}).`,
    { leadId, score: result.score, threshold: settings.score_threshold },
  );

  return {
    leadId,
    score: result.score,
    qualified,
    recommended: result.recommendedKey,
    confidence: result.confidence,
  };
};
