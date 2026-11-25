/**
 * Public website evidence.
 *
 * One page per lead, no crawling, no auth bypass. robots.txt is checked first
 * and a blanket disallow is honoured. A refusal is recorded as a refusal — it is
 * never turned into invented "research".
 */

export interface PageEvidence {
  url: string;
  finalUrl: string;
  httpStatus: number;
  title: string;
  description: string;
  text: string;
  emails: string[];
  hasHttps: boolean;
  wordCount: number;
}

export type PageResult =
  | { ok: true; evidence: PageEvidence }
  | { ok: false; reason: string; httpStatus: number };

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 300_000;
const USER_AGENT = 'NOVA-OS/0.1 (business research; single-page fetch)';

const EMAIL_NOISE = [
  'example.com',
  'sentry.io',
  'wixpress.com',
  'godaddy.com',
  'cloudflare.com',
  'schema.org',
  'domain.com',
  'email.com',
  'yourdomain.com',
];

export function normalizeUrl(raw: string): URL | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export function domainOf(raw: string): string | null {
  const url = normalizeUrl(raw);
  if (!url) return null;
  return url.hostname.replace(/^www\./i, '').toLowerCase();
}

/** A blanket `Disallow: /` for all agents is a no. Anything else is a yes. */
export async function robotsAllows(url: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL('/robots.txt', url.origin).toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) return true;
    if (response.status === 404 || response.status === 410) return true;

    const body = (await response.text()).slice(0, 100_000);
    let appliesToAll = false;

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;

      const [rawKey, ...rest] = line.split(':');
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(':').trim();

      if (key === 'user-agent') {
        appliesToAll = value === '*';
        continue;
      }

      if (appliesToAll && key === 'disallow' && value === '/') {
        return false;
      }
    }

    return true;
  } catch {
    // No robots.txt reachable: proceed with a single polite request.
    return true;
  }
}

export async function fetchPageEvidence(rawUrl: string): Promise<PageResult> {
  const url = normalizeUrl(rawUrl);

  if (!url) {
    return { ok: false, reason: 'The lead has no usable website URL.', httpStatus: 0 };
  }

  if (!(await robotsAllows(url))) {
    return {
      ok: false,
      reason: 'robots.txt disallows automated access to this site.',
      httpStatus: 0,
    };
  }

  let response: Response;

  try {
    response = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'The site took too long to respond.'
        : 'The site could not be reached.';
    return { ok: false, reason: message, httpStatus: 0 };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `The site responded with HTTP ${response.status}.`,
      httpStatus: response.status,
    };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('html') && contentType.length > 0) {
    return {
      ok: false,
      reason: `The site returned ${contentType.split(';')[0]}, not HTML.`,
      httpStatus: response.status,
    };
  }

  const raw = (await response.text()).slice(0, MAX_BYTES);
  const finalUrl = response.url || url.toString();

  return {
    ok: true,
    evidence: {
      url: url.toString(),
      finalUrl,
      httpStatus: response.status,
      title: extractTitle(raw),
      description: extractMetaDescription(raw),
      text: htmlToText(raw).slice(0, 6_000),
      emails: extractEmails(raw),
      hasHttps: finalUrl.startsWith('https://'),
      wordCount: htmlToText(raw).split(/\s+/).filter(Boolean).length,
    },
  };
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

function extractMetaDescription(html: string): string {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,500})["']/i,
    /<meta[^>]+content=["']([^"']{0,500})["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{0,500})["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  }

  return '';
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)));
}

/** Public addresses published by the business itself. Nothing is guessed. */
function extractEmails(html: string): string[] {
  const matches = new Set<string>();
  const pattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  for (const match of html.matchAll(pattern)) {
    const email = match[0].toLowerCase();
    if (email.length > 254) continue;
    if (EMAIL_NOISE.some((noise) => email.includes(noise))) continue;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(email)) continue;
    matches.add(email);
    if (matches.size >= 5) break;
  }

  return [...matches];
}
