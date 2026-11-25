/**
 * Outreach compliance helpers.
 *
 * Two rules drive this file:
 *   1. The body of a draft only ever restates facts the pipeline already stored.
 *      No model call, no invented compliment, no invented claim about the site.
 *   2. Every send is re-checked at send time, not just at draft time: suppression,
 *      the owner's toggle, the autonomy mode, the daily cap and the sender's
 *      verification all have to hold right before the request goes out.
 */

export const UNSUBSCRIBE_LINE =
  'If you would rather not hear from me again, reply with the word STOP and I will remove you and not contact you again.';

export interface DraftFacts {
  businessName: string;
  contactName: string | null;
  companyName: string;
  serviceName: string | null;
  priceCents: number | null;
  deliveryDays: number;
  observed: string[];
  website: string | null;
}

function firstName(full: string | null): string | null {
  if (!full) return null;
  const first = full.trim().split(/\s+/)[0];
  return first.length >= 2 ? first : null;
}

function money(cents: number | null): string | null {
  if (cents === null || cents <= 0) return null;
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * The one observation we lead with. Chosen from stored scoring reasons, in a
 * fixed order, so the same lead always produces the same email.
 */
function leadObservation(facts: DraftFacts): string | null {
  const reasons = facts.observed.map((reason) => reason.toLowerCase());

  if (!facts.website) {
    return 'I could not find a website for the business, so anyone searching for you has nothing of yours to land on.';
  }
  if (reasons.some((reason) => reason.includes('not served over https'))) {
    return 'Your site is served over plain HTTP, which browsers now mark as not secure before a visitor reads a word.';
  }
  if (reasons.some((reason) => reason.includes('thin or incomplete'))) {
    return 'Your homepage carries very little text and no meta description, so search engines have little to work with.';
  }
  if (reasons.some((reason) => reason.includes('no public contact address'))) {
    return 'I could not find a public contact address on the site, which makes it harder for a ready customer to reach you.';
  }
  if (reasons.some((reason) => reason.includes('could not be read'))) {
    return 'Your site did not respond when I tried to read it, which may be costing you visitors.';
  }

  return null;
}

export function buildDraft(facts: DraftFacts): { subject: string; body: string } {
  const greeting = firstName(facts.contactName) ?? 'there';
  const observation = leadObservation(facts);
  const price = money(facts.priceCents);

  const subject = facts.serviceName
    ? `${facts.businessName}: ${facts.serviceName.toLowerCase()}`
    : `A note about ${facts.businessName}`;

  const lines: string[] = [
    `Hi ${greeting},`,
    '',
    `I am ${facts.companyName}. I help small businesses with the practical side of being found online.`,
  ];

  if (observation) {
    lines.push('', observation);
  }

  if (facts.serviceName) {
    const offer = price
      ? `I can put together a ${facts.serviceName.toLowerCase()} for ${facts.businessName} for ${price}, delivered in about ${facts.deliveryDays} days.`
      : `I can put together a ${facts.serviceName.toLowerCase()} for ${facts.businessName}, delivered in about ${facts.deliveryDays} days.`;

    lines.push('', offer);
  }

  lines.push(
    '',
    'If that is useful, reply to this email and I will send the details before you commit to anything.',
    '',
    UNSUBSCRIBE_LINE,
    '',
    facts.companyName,
  );

  return { subject: subject.slice(0, 180), body: lines.join('\n').slice(0, 4000) };
}

export interface SendGateInput {
  emailEnabled: boolean;
  autonomyMode: string;
  accountEnabled: boolean;
  accountVerified: boolean;
  suppressed: boolean;
  sentToday: number;
  dailyCap: number;
  providerConfigured: boolean;
}

/** Returns the first blocking reason, or null when a send may proceed. */
export function sendBlockedReason(input: SendGateInput): string | null {
  if (!input.providerConfigured) return 'No email provider is configured on this project.';
  if (!input.emailEnabled) return 'Email is switched off in company settings.';
  if (!['outreach', 'sales', 'revenue', 'full'].includes(input.autonomyMode)) {
    return `The company mode is "${input.autonomyMode}"; email needs outreach or higher.`;
  }
  if (!input.accountEnabled) return 'The sending account is disabled.';
  if (!input.accountVerified) return 'The sending account has not been verified yet.';
  if (input.suppressed) return 'That address is on the suppression list.';
  if (input.dailyCap <= 0) return 'The daily email cap is zero.';
  if (input.sentToday >= input.dailyCap) {
    return `The daily email cap (${input.dailyCap}) is already reached.`;
  }
  return null;
}
