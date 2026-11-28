/**
 * Phase 9 policy checks.
 *
 * Run from the repository root:
 *
 *   deno test supabase/tests/phase9_policy_test.ts
 *
 * These are the decisions that do not need a database or a provider: scoring is
 * deterministic, a draft only restates stored facts and always carries an
 * opt-out line, every send gate fails closed, and only customer work is urgent
 * enough to bypass the idle cadence.
 */

import { buildDraft, sendBlockedReason, UNSUBSCRIBE_LINE } from '../functions/_shared/compliance.ts';
import { loopUrgency, type LoopSnapshot } from '../functions/_shared/loop-policy.ts';
import { scoreLead, type ScoreInput } from '../functions/_shared/scoring.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const catalog = [
  {
    key: 'website_audit',
    name: 'Website audit',
    enabled: true,
    price_cents: 15000,
    min_price_cents: null,
    max_price_cents: null,
  },
];

const baseScore: ScoreInput = {
  businessName: 'Acme Dental',
  industry: 'dental',
  location: 'Bristol',
  website: 'https://acme.example',
  page: {
    url: 'https://acme.example',
    finalUrl: 'https://acme.example',
    httpStatus: 200,
    title: 'Acme Dental',
    description: 'A friendly dental practice in Bristol with same-week appointments.',
    text: 'x'.repeat(400),
    emails: ['hello@acme.example'],
    hasHttps: true,
    wordCount: 300,
  },
  pageFailure: null,
  evidenceCount: 1,
  hasContact: true,
  industries: ['dental'],
  geography: ['bristol'],
  catalog,
};

Deno.test('scoring is deterministic and cites only observed facts', () => {
  const first = scoreLead(baseScore);
  const second = scoreLead(baseScore);

  assert(first.score === second.score, 'the same evidence produced two different scores');
  assert(first.score > 0 && first.score <= 100, 'the score is outside 0–100');
  assert(
    first.reasons.some((reason) => reason.includes('HTTP 200')),
    'the score does not cite the observed HTTP status',
  );
  assert(
    !first.reasons.some((reason) => /guarantee|viral|double your/i.test(reason)),
    'the score contains an invented marketing claim',
  );
});

Deno.test('a missing website scores lower and never invents a page result', () => {
  const withoutSite = scoreLead({ ...baseScore, website: null, page: null });

  assert(withoutSite.score < scoreLead(baseScore).score, 'a missing site did not lower the score');
  assert(
    withoutSite.reasons.includes('No website was found for this business.'),
    'the missing site was not stated plainly',
  );
});

Deno.test('a draft always carries the opt-out line and never invents a price', () => {
  const draft = buildDraft({
    businessName: 'Acme Dental',
    contactName: 'Pat',
    companyName: 'Local Reach Workshop',
    serviceName: 'Website audit',
    priceCents: null,
    deliveryDays: 7,
    observed: ['Website is not served over HTTPS.'],
    website: 'http://acme.example',
  });

  assert(draft.body.includes(UNSUBSCRIBE_LINE), 'the opt-out line is missing');
  assert(draft.body.includes('Hi Pat,'), 'the contact name was not used');
  assert(!draft.body.includes('$'), 'a price was invented for an unpriced service');
  assert(draft.body.includes('served over plain HTTP'), 'the stored observation is missing');
});

Deno.test('a priced draft states the stored price and delivery window', () => {
  const draft = buildDraft({
    businessName: 'Acme Dental',
    contactName: null,
    companyName: 'Local Reach Workshop',
    serviceName: 'Website audit',
    priceCents: 15000,
    deliveryDays: 5,
    observed: [],
    website: 'https://acme.example',
  });

  assert(draft.body.includes('$150'), 'the stored price is missing');
  assert(draft.body.includes('5 days'), 'the stored delivery window is missing');
});

Deno.test('every send gate fails closed', () => {
  const open = {
    emailEnabled: true,
    autonomyMode: 'outreach',
    accountEnabled: true,
    accountVerified: true,
    suppressed: false,
    sentToday: 0,
    dailyCap: 20,
    providerConfigured: true,
  };

  assert(sendBlockedReason(open) === null, 'an open gate was blocked');
  assert(sendBlockedReason({ ...open, providerConfigured: false }) !== null, 'missing provider passed');
  assert(sendBlockedReason({ ...open, emailEnabled: false }) !== null, 'disabled email passed');
  assert(sendBlockedReason({ ...open, autonomyMode: 'intelligence' }) !== null, 'draft-only mode passed');
  assert(sendBlockedReason({ ...open, accountVerified: false }) !== null, 'unverified sender passed');
  assert(sendBlockedReason({ ...open, suppressed: true }) !== null, 'suppressed address passed');
  assert(sendBlockedReason({ ...open, sentToday: 20 }) !== null, 'reached daily cap passed');
});

function snapshot(overrides: Partial<LoopSnapshot> = {}, counts: Partial<LoopSnapshot['counts']> = {}): LoopSnapshot {
  const baseCounts: LoopSnapshot['counts'] = {
    leadsTotal: 0,
    leadsQualified: 0,
    leadsToday: 0,
    leadsWithoutOutreach: 0,
    draftsPending: 0,
    approvedReady: 0,
    dueFollowUps: 0,
    repliesUndrafted: 0,
    dealsReady: 0,
    productionQueued: 0,
    productionReady: 0,
    deliveriesUnsent: 0,
    deliveredWithoutPlan: 0,
    discoveryToday: 0,
    jobsQueued: 0,
    jobsDead: 0,
    ordersPaid: 0,
  };

  return {
    mode: 'outreach',
    emailEnabled: false,
    discoveryEnabled: false,
    productionEnabled: false,
    dailyLeadCap: 25,
    dailyEmailCap: 20,
    aiBudgetCents: 0,
    aiSpendCents: 0,
    aiRemainingCents: 0,
    counts: { ...baseCounts, ...counts },
    next: {
      followUpId: null,
      replyEventId: null,
      production: null,
      delivery: null,
      approvedMessageId: null,
      leadId: null,
      deliveredMessageId: null,
    },
    serverTime: new Date(0).toISOString(),
    ...overrides,
  };
}

Deno.test('an empty company has no loop work at all', () => {
  const urgency = loopUrgency(snapshot());
  assert(!urgency.work && !urgency.urgent, 'an empty snapshot still asked for a cycle');
});

Deno.test('a due follow-up is urgent and bypasses the idle cadence', () => {
  const urgency = loopUrgency(snapshot({}, { dueFollowUps: 1 }));
  assert(urgency.work && urgency.urgent, 'a due follow-up was not urgent');
});

Deno.test('discovery is work but not urgent', () => {
  const urgency = loopUrgency(snapshot({ discoveryEnabled: true }));
  assert(urgency.work && !urgency.urgent, 'discovery should wait for the idle backoff');
});

Deno.test('discovery already attempted today is not work again', () => {
  const urgency = loopUrgency(snapshot({ discoveryEnabled: true }, { discoveryToday: 1 }));
  assert(!urgency.work, 'discovery was requested twice on the same UTC day');
});

Deno.test('approved mail behind a closed email gate is not polled every minute', () => {
  const urgency = loopUrgency(snapshot({ emailEnabled: false }, { approvedReady: 1 }));
  assert(!urgency.work, 'a closed gate kept the loop busy');
});

Deno.test('a paused company never has loop work', () => {
  const urgency = loopUrgency(
    snapshot({ mode: 'paused' }, { dueFollowUps: 3, repliesUndrafted: 2, leadsWithoutOutreach: 1 }),
  );
  assert(!urgency.work && !urgency.urgent, 'a paused company still queued work');
});
