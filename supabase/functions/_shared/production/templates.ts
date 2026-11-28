/**
 * Phase 6 — real deliverables.
 *
 * Every template writes a real file from the accepted brief. Nothing here
 * invents an observation, a price, a testimonial or a contact detail:
 *
 *   - business facts come from the stored lead and quote
 *   - a website audit contains only what a single HTTPS request observed
 *   - when a fact is missing the file says so instead of guessing
 *
 * Output is deterministic for the same brief, so a retried generation produces
 * the same bytes unless the brief or QA notes changed.
 */

export interface ProductionBrief {
  jobId: string;
  title: string;
  serviceKey: string | null;
  businessName: string | null;
  website: string | null;
  location: string | null;
  industry: string | null;
  contactEmail: string | null;
  scope: string;
  deliverables: string;
  terms: string;
  requirements: string[];
  preparedAt: string;
}

export type GeneratedKind = 'primary' | 'preview' | 'asset';

export interface GeneratedFile {
  name: string;
  mime: string;
  kind: GeneratedKind;
  bytes: Uint8Array;
}

/** The facts observed from one public page, never invented. */
export interface WebsiteObservation {
  url: string;
  checkedAt: string;
  ok: boolean;
  error: string | null;
  status: number | null;
  elapsedMs: number | null;
  title: string | null;
  description: string | null;
  hasViewport: boolean;
  h1Count: number;
  imageCount: number;
  imagesMissingAlt: number;
  internalLinkCount: number;
  insecureLinkCount: number;
  wordCount: number;
  htmlBytes: number;
}

const enc = new TextEncoder();

function bytes(text: string): Uint8Array {
  return enc.encode(text);
}

export function slug(value: string, fallback = 'deliverable'): string {
  const slugged = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slugged.length > 0 ? slugged : fallback;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function displayDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

function businessName(brief: ProductionBrief): string {
  return safeText(brief.businessName, 'Your business');
}

function serviceLabel(brief: ProductionBrief): string {
  return safeText(brief.title, 'Digital service');
}

function scopeLine(brief: ProductionBrief): string {
  return safeText(brief.scope, safeText(brief.deliverables, 'The work described in the accepted quote.'));
}

function requirementList(brief: ProductionBrief): string[] {
  return Array.isArray(brief.requirements)
    ? brief.requirements.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function contextLine(brief: ProductionBrief): string {
  const parts = [safeText(brief.industry), safeText(brief.location)].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Small business';
}

/* ------------------------------------------------------------------ audit */

const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain']);

function safeHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host)) return null;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return null;
  if (host.endsWith('.home.arpa')) return null;
  if (!host.includes('.')) return null;
  // IP literals, including IPv6 in brackets, are refused.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return null;

  return url;
}

function countMatches(html: string, pattern: RegExp): number {
  const matches = html.match(pattern);
  return matches ? matches.length : 0;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One public HTTPS request, with redirects re-validated at every hop.
 * No browser rendering, no cookies, no authentication. The report says exactly
 * that, so a reader never mistakes it for a full browser audit.
 */
export async function observeWebsite(rawUrl: string): Promise<WebsiteObservation> {
  const checkedAt = new Date().toISOString();
  const base: WebsiteObservation = {
    url: rawUrl,
    checkedAt,
    ok: false,
    error: null,
    status: null,
    elapsedMs: null,
    title: null,
    description: null,
    hasViewport: false,
    h1Count: 0,
    imageCount: 0,
    imagesMissingAlt: 0,
    internalLinkCount: 0,
    insecureLinkCount: 0,
    wordCount: 0,
    htmlBytes: 0,
  };

  let current = safeHttpsUrl(rawUrl);
  if (!current) {
    return { ...base, error: 'The stored URL is not a public HTTPS address, so it was not fetched.' };
  }

  const started = Date.now();

  for (let hop = 0; hop < 4; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': 'NOVA-OS-Audit/1.0 (+https://localreachworkshop.example)' },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      return {
        ...base,
        url: current.toString(),
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message.slice(0, 300) : 'The request failed.',
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { ...base, url: current.toString(), status: response.status, error: 'The server redirected without a location.' };
      }
      let next: URL | null;
      try {
        next = safeHttpsUrl(new URL(location, current).toString());
      } catch {
        next = null;
      }
      if (!next) {
        return {
          ...base,
          url: current.toString(),
          status: response.status,
          error: 'The redirect left HTTPS or pointed at a non-public address, so it was not followed.',
        };
      }
      current = next;
      continue;
    }

    const elapsedMs = Date.now() - started;
    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return {
        ...base,
        url: current.toString(),
        status: response.status,
        elapsedMs,
        error: `The response was ${contentType || 'not HTML'}, so no page checks were possible.`,
      };
    }

    const raw = await response.text();
    const html = raw.slice(0, 600_000);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descriptionMatch = html.match(
      /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i,
    );
    const viewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
    const h1Count = countMatches(html, /<h1\b/gi);
    const imageTags = html.match(/<img\b[^>]*>/gi) ?? [];
    const imagesMissingAlt = imageTags.filter((tag) => !/\balt\s*=\s*["'][^"']+["']/i.test(tag)).length;
    const links = html.match(/<a\b[^>]*href\s*=\s*["'][^"']*["'][^>]*>/gi) ?? [];
    const insecureLinkCount = links.filter((tag) => /href\s*=\s*["']http:\/\//i.test(tag)).length;

    return {
      url: current.toString(),
      checkedAt,
      ok: response.ok,
      error: response.ok ? null : `The page returned HTTP ${response.status}.`,
      status: response.status,
      elapsedMs,
      title: titleMatch ? stripTags(titleMatch[1]).slice(0, 240) : null,
      description: descriptionMatch ? descriptionMatch[1].trim().slice(0, 400) : null,
      hasViewport: viewport,
      h1Count,
      imageCount: imageTags.length,
      imagesMissingAlt,
      internalLinkCount: links.length,
      insecureLinkCount,
      wordCount: stripTags(html).split(/\s+/).filter(Boolean).length,
      htmlBytes: raw.length,
    };
  }

  return {
    ...base,
    url: current.toString(),
    elapsedMs: Date.now() - started,
    error: 'The page redirected too many times, so it was not followed further.',
  };
}

function auditFindings(observation: WebsiteObservation): string[] {
  if (observation.error && !observation.status) {
    return [`The page could not be fetched: ${observation.error} No on-page finding is claimed.`];
  }

  const findings: string[] = [];

  if (observation.status !== null && observation.status !== 200) {
    findings.push(`The page returned HTTP ${observation.status}, so visitors may not reach it.`);
  }
  if (!observation.title) {
    findings.push('No page title was found. A title is what search results and browser tabs show.');
  } else {
    findings.push(`The page title is "${observation.title}" (${observation.title.length} characters).`);
  }
  if (!observation.description) {
    findings.push('No meta description was found. Search engines may write their own snippet.');
  }
  if (!observation.hasViewport) {
    findings.push('No mobile viewport meta tag was found, so phones may render the desktop layout scaled down.');
  }
  if (observation.h1Count === 0) {
    findings.push('No H1 heading was found, which makes the main offer harder to identify.');
  } else if (observation.h1Count > 1) {
    findings.push(`${observation.h1Count} H1 headings were found; one main heading is usually clearer.`);
  }
  if (observation.imagesMissingAlt > 0) {
    findings.push(
      `${observation.imagesMissingAlt} of ${observation.imageCount} images have no alt text, which weakens accessibility.`,
    );
  }
  if (observation.insecureLinkCount > 0) {
    findings.push(`${observation.insecureLinkCount} links point at plain HTTP rather than HTTPS.`);
  }
  if (observation.wordCount < 250) {
    findings.push(`The page contains about ${observation.wordCount} words, which is thin for a service page.`);
  }
  if (observation.elapsedMs !== null && observation.elapsedMs > 2500) {
    findings.push(`The HTML took ${observation.elapsedMs} ms to arrive. Slow responses lose mobile visitors.`);
  }
  if (findings.length === 0) {
    findings.push('No blocking issue was found in the checks above. This is not a full performance or accessibility audit.');
  }

  return findings;
}

function auditReport(brief: ProductionBrief, observation: WebsiteObservation): string {
  const name = businessName(brief);
  const findings = auditFindings(observation);
  const rows: string[] = [];

  if (observation.status !== null) rows.push(`| HTTP status | ${observation.status} |`);
  if (observation.elapsedMs !== null) rows.push(`| HTML response time | ${observation.elapsedMs} ms |`);
  rows.push(`| Page title | ${observation.title ? observation.title : 'not found'} |`);
  rows.push(`| Meta description | ${observation.description ? 'present' : 'not found'} |`);
  rows.push(`| Mobile viewport | ${observation.hasViewport ? 'declared' : 'not found'} |`);
  rows.push(`| H1 headings | ${observation.h1Count} |`);
  rows.push(`| Images without alt | ${observation.imagesMissingAlt} of ${observation.imageCount} |`);
  rows.push(`| Links | ${observation.internalLinkCount} (${observation.insecureLinkCount} on HTTP) |`);
  rows.push(`| Words in main HTML | ${observation.wordCount} |`);
  rows.push(`| HTML size | ${observation.htmlBytes} characters |`);

  return [
    `# Website audit - ${name}`,
    '',
    `Prepared by Local Reach Workshop on ${displayDate(brief.preparedAt)}.`,
    `Website checked: ${observation.url}`,
    `Scope: ${scopeLine(brief)}`,
    '',
    '## How this was checked',
    '',
    'One direct HTTPS request was made to the public page. The HTML was inspected for its',
    'title, description, mobile viewport, heading structure, image alt text, links and',
    'response time. No browser rendering, JavaScript execution, login or private data was used.',
    observation.error ? `The check reported: ${observation.error}` : 'The page responded successfully.',
    '',
    '## Observed',
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...rows,
    '',
    '## Findings',
    '',
    ...findings.map((finding) => `- ${finding}`),
    '',
    '## Prioritised fixes',
    '',
    ...findings.slice(0, 6).map((finding, index) => `${index + 1}. ${finding}`),
    '',
    '## What this report does not cover',
    '',
    '- Real-device rendering, Core Web Vitals or JavaScript errors.',
    '- Search rankings, backlinks or competitor positions.',
    '- Anything behind a login or a form.',
    '',
    brief.terms ? `Terms: ${brief.terms}` : '',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/* ------------------------------------------------------------------- pdf */

function ascii(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\n]/g, ' ');
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const words = line.split(/\s+/);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > width) {
      if (current) out.push(current);
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) out.push(current);
  return out;
}

function pdfEscape(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A small, valid PDF 1.4 writer for the text reports.
 * One font (Helvetica), automatic pagination, no external dependency.
 */
export function textPdf(title: string, body: string): Uint8Array {
  const lines = [title, '', ...body.split('\n')]
    .flatMap((line) => (line.length === 0 ? [''] : wrapLine(ascii(line), 88)))
    .slice(0, 900);

  const perPage = 42;
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += perPage) {
    pages.push(lines.slice(index, index + perPage));
  }
  if (pages.length === 0) pages.push(['']);

  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const contentIds = pages.map((_, index) => 5 + index * 2);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((page, index) => {
    const stream = [
      'BT',
      '/F1 11 Tf',
      '14 TL',
      '54 738 Td',
      ...page.map((line) => `(${pdfEscape(line)}) Tj T*`),
      'ET',
    ].join('\n');

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return bytes(pdf);
}

/* ------------------------------------------------------------- templates */

function mdHeader(brief: ProductionBrief, subtitle: string): string[] {
  return [
    `# ${serviceLabel(brief)} - ${businessName(brief)}`,
    '',
    subtitle,
    '',
    `Prepared for ${businessName(brief)} by Local Reach Workshop on ${displayDate(brief.preparedAt)}.`,
    `Context: ${contextLine(brief)}`,
    `Scope: ${scopeLine(brief)}`,
    '',
  ];
}

function auditFiles(brief: ProductionBrief, observation: WebsiteObservation | null): GeneratedFile[] {
  const report = observation
    ? auditReport(brief, observation)
    : [
        ...mdHeader(brief, 'Website audit worksheet.'),
        '## No page was checked',
        '',
        'No public HTTPS website was stored for this business, so no page was fetched and',
        'no observation is claimed. Add the website to the lead, then run production again.',
        '',
        '## Checks to run manually',
        '',
        '- Does the page load on a phone without horizontal scrolling?',
        '- Is the main service and location clear within the first screen?',
        '- Is there one clear way to enquire?',
        '- Do the title and description describe the service and area?',
        '',
      ].join('\n');

  const fixRows = observation
    ? auditFindings(observation).map((finding, index) => `${index + 1},"${finding.replace(/"/g, '""')}"`)
    : ['1,"Add the website URL to the lead and run production again."'];

  return [
    {
      name: 'website-audit.md',
      mime: 'text/markdown',
      kind: 'primary',
      bytes: bytes(report),
    },
    {
      name: 'website-audit.pdf',
      mime: 'application/pdf',
      kind: 'primary',
      bytes: textPdf(`Website audit - ${businessName(brief)}`, report),
    },
    {
      name: 'fix-list.csv',
      mime: 'text/csv',
      kind: 'asset',
      bytes: bytes(['priority,finding', ...fixRows].join('\n')),
    },
  ];
}

function landingFiles(brief: ProductionBrief): GeneratedFile[] {
  const name = businessName(brief);
  const service = serviceLabel(brief);
  const scope = scopeLine(brief);
  const context = contextLine(brief);
  const email = safeText(brief.contactEmail);
  const cta = email
    ? `<a class="button" href="mailto:${escapeHtml(email)}?subject=${encodeURIComponent(`Enquiry about ${service}`)}">Ask about ${escapeHtml(service)}</a>`
    : '<a class="button" href="#enquire">Ask about this service</a>';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)} - ${escapeHtml(service)}</title>
  <meta name="description" content="${escapeHtml(`${service} from ${name}. ${scope}`.slice(0, 158))}">
  <style>
    :root { color-scheme: light; --ink: #101828; --muted: #475467; --line: #e4e7ec; --brand: #0f766e; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; color: var(--ink); line-height: 1.6; }
    header, main, footer { max-width: 960px; margin: 0 auto; padding: 0 24px; }
    header { padding-top: 28px; padding-bottom: 18px; display: flex; justify-content: space-between; align-items: baseline; gap: 16px; border-bottom: 1px solid var(--line); }
    .brand { font-weight: 700; letter-spacing: -0.02em; }
    .context { color: var(--muted); font-size: 14px; }
    .hero { padding: 64px 0 40px; }
    .eyebrow { color: var(--brand); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; }
    h1 { font-size: clamp(32px, 6vw, 54px); line-height: 1.05; letter-spacing: -0.03em; margin: 12px 0 18px; }
    .lead { font-size: 19px; color: var(--muted); max-width: 680px; }
    .button { display: inline-block; margin-top: 26px; background: var(--brand); color: white; text-decoration: none; padding: 14px 22px; border-radius: 10px; font-weight: 600; }
    section { padding: 36px 0; border-top: 1px solid var(--line); }
    h2 { font-size: 24px; letter-spacing: -0.02em; margin: 0 0 12px; }
    ul { padding-left: 20px; }
    .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .card { border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
    footer { padding: 28px 0 48px; color: var(--muted); font-size: 13px; }
    @media (max-width: 640px) { .hero { padding-top: 44px; } }
  </style>
</head>
<body>
  <header>
    <span class="brand">${escapeHtml(name)}</span>
    <span class="context">${escapeHtml(context)}</span>
  </header>
  <main>
    <section class="hero">
      <p class="eyebrow">${escapeHtml(service)}</p>
      <h1>${escapeHtml(name)}</h1>
      <p class="lead">${escapeHtml(scope)}</p>
      ${cta}
    </section>
    <section>
      <h2>What you get</h2>
      <div class="grid">
        <div class="card"><strong>Clear scope</strong><p>${escapeHtml(safeText(brief.deliverables, scope))}</p></div>
        <div class="card"><strong>Direct contact</strong><p>${email ? `Email ${escapeHtml(email)} and we will reply with the next step.` : 'Use the enquiry button and we will reply with the next step.'}</p></div>
        <div class="card"><strong>Agreed terms</strong><p>${escapeHtml(safeText(brief.terms, 'Scope, price and timing are agreed in writing before work starts.'))}</p></div>
      </div>
    </section>
    <section id="enquire">
      <h2>Enquire</h2>
      <p>Tell us what you need and we will confirm scope, price and timing in writing.</p>
      ${cta}
    </section>
  </main>
  <footer>
    <p>${escapeHtml(name)} - ${escapeHtml(service)}. Prepared by Local Reach Workshop.</p>
    <!-- Replace the enquiry link with the business phone number or booking page before publishing. -->
  </footer>
</body>
</html>`;

  const copy = [
    ...mdHeader(brief, 'Landing page copy, ready to review before publishing.'),
    '## Hero',
    '',
    `- Eyebrow: ${service}`,
    `- Headline: ${name}`,
    `- Supporting line: ${scope}`,
    '',
    '## What you get',
    '',
    `- ${safeText(brief.deliverables, scope)}`,
    '- A direct way to enquire.',
    `- Terms: ${safeText(brief.terms, 'Scope, price and timing agreed in writing before work starts.')}`,
    '',
    '## Before publishing',
    '',
    '- Replace the enquiry button with the real phone number, booking page or form.',
    '- Check the business name, service and area are exactly right.',
    '- Publish over HTTPS and test on a phone.',
    '',
  ].join('\n');

  return [
    { name: 'index.html', mime: 'text/html', kind: 'primary', bytes: bytes(html) },
    { name: 'landing-copy.md', mime: 'text/markdown', kind: 'preview', bytes: bytes(copy) },
  ];
}

function profileFiles(brief: ProductionBrief): GeneratedFile[] {
  const name = businessName(brief);
  const service = serviceLabel(brief);
  const location = safeText(brief.location, 'your service area');
  const industry = safeText(brief.industry, 'local service');

  const description = `${name} helps customers in ${location} with ${service.toLowerCase()}. ${scopeLine(brief)} Contact us to confirm scope, price and timing before work starts.`;

  const setup = [
    ...mdHeader(brief, 'Google Business Profile setup sheet.'),
    '## Profile basics',
    '',
    `- Business name: ${name}`,
    `- Primary category: choose the closest match to "${industry}"`,
    `- Service area: ${location}`,
    '- Hours: add the real opening hours in the profile (not guessed here).',
    '- Phone: add the real business number.',
    '- Website: ' + safeText(brief.website, 'add the real website if one exists'),
    '',
    '## Business description',
    '',
    description,
    '',
    '## Services to add',
    '',
    `- ${service}`,
    '',
    '## First posts',
    '',
    '1. Introduce the business and the service in two sentences.',
    '2. Share one practical tip related to the service.',
    '3. Invite customers to ask for a quote.',
    '',
    '## Review request link',
    '',
    'Create the review link in the profile, then add it to the review request kit.',
    '',
  ].join('\n');

  return [
    { name: 'profile-setup.md', mime: 'text/markdown', kind: 'primary', bytes: bytes(setup) },
    { name: 'profile-description.txt', mime: 'text/plain', kind: 'asset', bytes: bytes(description) },
  ];
}

function contentFiles(brief: ProductionBrief): GeneratedFile[] {
  const name = businessName(brief);
  const service = serviceLabel(brief);
  const location = safeText(brief.location, 'the local area');
  const industry = safeText(brief.industry, 'local business');
  const themes = [
    ['Introduce the service', `Explain what ${service.toLowerCase()} includes and who it is for.`],
    ['Answer a common question', `Answer one question ${industry} customers ask before buying.`],
    ['Show the process', 'Walk through what happens from first enquiry to finished work.'],
    ['Local relevance', `Mention ${location} and one place or season the service fits.`],
    ['Before and after thinking', 'Describe the problem the customer starts with and the outcome they want.'],
    ['Meet the owner', 'Share why the business does this work and how it works with customers.'],
    ['Myth vs fact', 'Correct one common misunderstanding about the service.'],
    ['Simple call to action', 'Invite readers to ask for a quote and say what to include in the message.'],
  ];

  const rows = themes.map((theme, index) => {
    const week = Math.floor(index / 2) + 1;
    const day = index % 2 === 0 ? 'Tuesday' : 'Friday';
    return `${week},${day},Social,"${theme[0]}","${theme[1].replace(/"/g, '""')}"`;
  });

  const posts = themes
    .map((theme, index) => {
      return [
        `## Post ${index + 1} - ${theme[0]}`,
        '',
        `${theme[1]}`,
        '',
        `Draft: ${name} helps customers with ${service.toLowerCase()} in ${location}. ${theme[1]} If this is useful, send a message and we will confirm scope, price and timing in writing.`,
        '',
      ].join('\n');
    })
    .join('\n');

  const body = [
    ...mdHeader(brief, 'Four-week content starter pack.'),
    '## How to use it',
    '',
    'Publish two posts a week. Adjust the wording to the owner voice before publishing;',
    'do not add claims, awards or testimonials that the business cannot evidence.',
    '',
    posts,
  ].join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeHtml(name)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="1" stop-color="#123a3a"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="80" y="250" fill="#99f6e4" font-family="Arial, sans-serif" font-size="28" letter-spacing="4">${escapeHtml(service.toUpperCase())}</text>
  <text x="80" y="360" fill="#ffffff" font-family="Arial, sans-serif" font-size="74" font-weight="bold">${escapeHtml(name)}</text>
  <text x="80" y="430" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="30">${escapeHtml(location)}</text>
</svg>`;

  return [
    { name: 'content-calendar.csv', mime: 'text/csv', kind: 'primary', bytes: bytes(['week,day,channel,theme,caption', ...rows].join('\n')) },
    { name: 'posts.md', mime: 'text/markdown', kind: 'primary', bytes: bytes(body) },
    { name: 'social-card.svg', mime: 'image/svg+xml', kind: 'asset', bytes: bytes(svg) },
  ];
}

function reviewFiles(brief: ProductionBrief): GeneratedFile[] {
  const name = businessName(brief);
  const service = serviceLabel(brief);

  const kit = [
    ...mdHeader(brief, 'Review request kit.'),
    '## The rule',
    '',
    'Ask every happy customer once, at the moment the work is finished. Never offer an',
    'incentive for a review and never filter out unhappy customers first.',
    '',
    '## When to ask',
    '',
    '- After the customer confirms the work is done.',
    '- One polite reminder after 5-7 days if there is no review.',
    '- Stop after that.',
    '',
    '## Email template',
    '',
    `Subject: How did we do with ${service.toLowerCase()}?`,
    '',
    `Hi [customer name],`,
    '',
    `Thank you for choosing ${name}. If the work was what you needed, would you leave a short review? It helps other local customers decide.`,
    '',
    'Review link: [add your Google review link before sending]',
    '',
    'If anything is not right, reply to this email and we will fix it first.',
    '',
    `Thanks,`,
    name,
    '',
    '## Short message template',
    '',
    `${name}: thanks for your business. If you have a minute, a short review helps: [review link]`,
    '',
    '## What not to do',
    '',
    '- Do not write the review for the customer.',
    '- Do not ask only the customers you know are happy.',
    '- Do not send repeated reminders.',
    '',
  ].join('\n');

  const email = [
    `Subject: How did we do with ${service.toLowerCase()}?`,
    '',
    'Hi [customer name],',
    '',
    `Thank you for choosing ${name}. If the work was what you needed, would you leave a short review? It helps other local customers decide.`,
    '',
    'Review link: [add your Google review link before sending]',
    '',
    'If anything is not right, reply to this email and we will fix it first.',
    '',
    'Thanks,',
    name,
  ].join('\n');

  return [
    { name: 'review-request-kit.md', mime: 'text/markdown', kind: 'primary', bytes: bytes(kit) },
    { name: 'review-request-email.txt', mime: 'text/plain', kind: 'asset', bytes: bytes(email) },
  ];
}

function sequenceFiles(brief: ProductionBrief): GeneratedFile[] {
  const name = businessName(brief);
  const service = serviceLabel(brief);

  const steps = [
    ['Day 0', 'Acknowledge the enquiry', 'Confirm you have the message and say when you will reply properly.'],
    ['Day 2', 'Answer the question', 'Reply with the specific information the customer asked for.'],
    ['Day 5', 'Offer the next step', 'Invite a short call or a written quote, with no pressure.'],
  ];

  const body = [
    ...mdHeader(brief, 'Three-email enquiry follow-up sequence.'),
    '## How to use it',
    '',
    'Send each email only if the customer has not replied. Stop immediately on any reply,',
    'opt-out or bounce, and never send more than three messages.',
    '',
    ...steps.flatMap((step, index) => [
      `## Email ${index + 1} - ${step[0]}: ${step[1]}`,
      '',
      `Subject: ${index === 0 ? `Your enquiry about ${service.toLowerCase()}` : `Following up on ${service.toLowerCase()}`}`,
      '',
      `Hi [customer name],`,
      '',
      index === 0
        ? `Thanks for getting in touch with ${name}. I have your message and will come back with the details you need.`
        : index === 1
          ? `Just following up on your enquiry about ${service.toLowerCase()}. If you tell me the one thing that matters most, I can focus my answer.`
          : `If now is not the right time, that is fine. If it is, I can confirm scope, price and timing in writing.`,
      '',
      'Thanks,',
      name,
      '',
      `What to do: ${step[2]}`,
      '',
    ]),
    '## Stop rules',
    '',
    '- Any reply ends the sequence.',
    '- Any opt-out suppresses the address.',
    '- A bounce cancels the remaining emails.',
    '',
  ].join('\n');

  const csv = [
    'step,day,subject,goal',
    ...steps.map((step, index) => `${index + 1},${step[0]},"${step[1]}","${step[2].replace(/"/g, '""')}"`),
  ].join('\n');

  return [
    { name: 'enquiry-follow-up.md', mime: 'text/markdown', kind: 'primary', bytes: bytes(body) },
    { name: 'sequence.csv', mime: 'text/csv', kind: 'asset', bytes: bytes(csv) },
  ];
}

function genericFiles(brief: ProductionBrief): GeneratedFile[] {
  const body = [
    ...mdHeader(brief, 'Deliverable brief and handover notes.'),
    '## Agreed scope',
    '',
    scopeLine(brief),
    '',
    '## Deliverables',
    '',
    safeText(brief.deliverables, 'See the accepted quote for the agreed deliverables.'),
    '',
    '## Requirements from the customer',
    '',
    ...(requirementList(brief).length > 0
      ? requirementList(brief).map((item) => `- ${item}`)
      : ['- None recorded.']),
    '',
    '## Terms',
    '',
    safeText(brief.terms, 'See the accepted quote for the agreed terms.'),
    '',
    '## Handover',
    '',
    'This file is the written handover for the order. Add the finished work beside it before delivery.',
    '',
  ].join('\n');

  const checklist = [
    ...mdHeader(brief, 'Handover checklist.'),
    '## Before delivery',
    '',
    '- The work matches the agreed scope above.',
    '- Every file opens and every link works.',
    '- The customer requirements are included or explicitly out of scope.',
    '- No price, claim or testimonial was added that the business cannot evidence.',
    '- The terms and revision allowance were explained in the delivery email.',
    '',
    '## Evidence',
    '',
    `Prepared ${displayDate(brief.preparedAt)} for ${businessName(brief)}.`,
    '',
  ].join('\n');

  return [
    { name: 'deliverable.md', mime: 'text/markdown', kind: 'primary', bytes: bytes(body) },
    { name: 'handover-checklist.md', mime: 'text/markdown', kind: 'asset', bytes: bytes(checklist) },
  ];
}

const TEMPLATES: Record<string, (brief: ProductionBrief, observation: WebsiteObservation | null) => GeneratedFile[]> = {
  website_audit: auditFiles,
  landing_page: landingFiles,
  google_business_profile: profileFiles,
  content_starter: contentFiles,
  review_request_kit: reviewFiles,
  enquiry_followup: sequenceFiles,
};

export function hasTemplate(serviceKey: string | null): boolean {
  return Boolean(serviceKey && TEMPLATES[serviceKey]);
}

export async function generateProductionFiles(
  brief: ProductionBrief,
): Promise<{ files: GeneratedFile[]; observation: WebsiteObservation | null }> {
  const template = (brief.serviceKey && TEMPLATES[brief.serviceKey]) || genericFiles;
  const observation =
    brief.serviceKey === 'website_audit' && brief.website
      ? await observeWebsite(brief.website)
      : null;

  return { files: template(brief, observation), observation };
}
