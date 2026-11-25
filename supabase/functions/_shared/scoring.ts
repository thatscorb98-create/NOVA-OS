import type { PageEvidence } from './providers/website.ts';

/**
 * STERLING scoring.
 *
 * Deterministic and explainable on purpose: every point traces to something
 * that was actually observed, and every reason is stored. No model call is
 * involved, so the same lead always scores the same way and nothing can be
 * hallucinated into a score.
 */

export interface CatalogService {
  key: string;
  name: string;
  enabled: boolean;
  price_cents: number | null;
  min_price_cents: number | null;
  max_price_cents: number | null;
}

export interface ScoreInput {
  businessName: string;
  industry: string | null;
  location: string | null;
  website: string | null;
  page: PageEvidence | null;
  pageFailure: string | null;
  evidenceCount: number;
  hasContact: boolean;
  industries: string[];
  geography: string[];
  catalog: CatalogService[];
}

export interface ScoreOutput {
  score: number;
  breakdown: Record<string, number>;
  reasons: string[];
  confidence: number;
  recommendedKey: string | null;
  recommendedName: string | null;
  priceRange: { minCents: number; maxCents: number } | null;
}

const WEIGHTS = {
  industry_match: 20,
  location_match: 15,
  website_present: 10,
  site_reachable: 15,
  contact_found: 20,
  content_depth: 10,
  https: 5,
  evidence: 5,
} as const;

function matchesAny(haystack: string | null, needles: string[]): boolean {
  if (!haystack || needles.length === 0) return false;
  const value = haystack.toLowerCase();
  return needles.some((needle) => {
    const target = needle.trim().toLowerCase();
    return target.length > 1 && value.includes(target);
  });
}

export function scoreLead(input: ScoreInput): ScoreOutput {
  const breakdown: Record<string, number> = {
    industry_match: 0,
    location_match: 0,
    website_present: 0,
    site_reachable: 0,
    contact_found: 0,
    content_depth: 0,
    https: 0,
    evidence: 0,
  };
  const reasons: string[] = [];

  if (matchesAny(input.industry, input.industries)) {
    breakdown.industry_match = WEIGHTS.industry_match;
    reasons.push(`Industry matches the configured targets (${input.industry}).`);
  } else if (input.industry) {
    reasons.push(`Industry "${input.industry}" is outside the configured targets.`);
  }

  if (matchesAny(input.location, input.geography)) {
    breakdown.location_match = WEIGHTS.location_match;
    reasons.push(`Located in a configured area (${input.location}).`);
  } else if (input.location) {
    reasons.push(`Location "${input.location}" is outside the configured areas.`);
  }

  if (input.website) {
    breakdown.website_present = WEIGHTS.website_present;
    reasons.push('A public website was found.');
  } else {
    reasons.push('No website was found for this business.');
  }

  if (input.page) {
    breakdown.site_reachable = WEIGHTS.site_reachable;
    reasons.push(`Website responded with HTTP ${input.page.httpStatus}.`);

    if (input.page.hasHttps) {
      breakdown.https = WEIGHTS.https;
    } else {
      reasons.push('Website is not served over HTTPS.');
    }

    const depth = input.page.wordCount;
    const described = input.page.description.length >= 40;

    if (depth >= 250 && described) {
      breakdown.content_depth = WEIGHTS.content_depth;
      reasons.push(`Page has ${depth} words and a meta description.`);
    } else if (depth > 0 || described) {
      breakdown.content_depth = Math.round(WEIGHTS.content_depth / 2);
      reasons.push(
        `Thin or incomplete page content (${depth} words${described ? '' : ', no meta description'}).`,
      );
    } else {
      reasons.push('The page returned almost no readable content.');
    }
  } else if (input.website) {
    reasons.push(input.pageFailure ?? 'The website could not be read.');
  }

  if (input.hasContact) {
    breakdown.contact_found = WEIGHTS.contact_found;
    reasons.push('A public contact address was found.');
  } else {
    reasons.push('No public contact address was found yet.');
  }

  const evidenceScore = Math.min(WEIGHTS.evidence, input.evidenceCount * 2);
  if (evidenceScore > 0) {
    breakdown.evidence = evidenceScore;
    reasons.push(`${input.evidenceCount} source(s) captured with timestamps.`);
  }

  const score = Object.values(breakdown).reduce((total, value) => total + value, 0);

  const confidence =
    Math.round(
      Math.min(1, (input.evidenceCount / 3) * 0.6 + (input.page ? 0.4 : 0)) * 1000,
    ) / 1000;

  const recommendation = recommendService(input);

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    breakdown,
    reasons,
    confidence,
    recommendedKey: recommendation.key,
    recommendedName: recommendation.name,
    priceRange: recommendation.priceRange,
  };
}

/**
 * Pick a service from the approved catalog only. If nothing in the catalog is
 * enabled and priced, no service is recommended — the owner is told to set
 * prices instead of being shown an invented figure.
 */
function recommendService(input: ScoreInput): {
  key: string | null;
  name: string | null;
  priceRange: { minCents: number; maxCents: number } | null;
} {
  const priced = input.catalog.filter(
    (service) =>
      service.enabled &&
      (service.price_cents !== null ||
        (service.min_price_cents !== null && service.max_price_cents !== null)),
  );

  if (priced.length === 0) {
    return { key: null, name: null, priceRange: null };
  }

  const weakSite =
    !input.page ||
    !input.page.hasHttps ||
    input.page.wordCount < 250 ||
    input.page.description.length < 40;

  const preference = !input.website
    ? ['landing_page', 'google_business_profile', 'website_audit']
    : weakSite
      ? ['website_audit', 'landing_page', 'google_business_profile']
      : !input.hasContact
        ? ['google_business_profile', 'content_starter', 'landing_page']
        : ['content_starter', 'review_request_kit', 'enquiry_followup'];

  const chosen =
    preference
      .map((key) => priced.find((service) => service.key === key))
      .find((service): service is CatalogService => Boolean(service)) ?? priced[0];

  const minCents = chosen.min_price_cents ?? chosen.price_cents ?? 0;
  const maxCents = chosen.max_price_cents ?? chosen.price_cents ?? minCents;

  return { key: chosen.key, name: chosen.name, priceRange: { minCents, maxCents } };
}
