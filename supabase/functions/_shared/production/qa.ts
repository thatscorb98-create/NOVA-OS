/**
 * SENTINEL's production checks.
 *
 * These are deterministic, file-level checks: the file exists, is the type it
 * claims, opens as that type, carries the business name, contains no unresolved
 * template token and no plain-HTTP link. They are not a browser test and the
 * Studio says so. A failed check returns the job to production with the notes.
 */

import type { ProductionBrief } from './templates.ts';

export interface QaFile {
  name: string;
  mime: string;
  kind: string;
  bytes: Uint8Array;
}

export interface QaCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface QaResult {
  verdict: 'pass' | 'fail';
  checks: QaCheck[];
  notes: string | null;
}

const EXPECTED_MIME: Record<string, string[]> = {
  md: ['text/markdown', 'text/plain'],
  html: ['text/html'],
  csv: ['text/csv', 'text/plain'],
  txt: ['text/plain'],
  svg: ['image/svg+xml'],
  pdf: ['application/pdf'],
};

function extension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function looksLikeText(mime: string, ext: string): boolean {
  return mime.startsWith('text/') || ['md', 'html', 'csv', 'txt', 'svg'].includes(ext);
}

export function inspectFiles(files: QaFile[], brief: ProductionBrief): QaResult {
  const checks: QaCheck[] = [];

  const add = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
  };

  add('files-present', files.length >= 2, `${files.length} file(s) stored for this version.`);
  add(
    'primary-present',
    files.some((file) => file.kind === 'primary'),
    'At least one primary deliverable is required.',
  );

  for (const file of files) {
    const ext = extension(file.name);
    const allowed = EXPECTED_MIME[ext];
    add(
      `type-${file.name}`,
      Boolean(allowed && allowed.includes(file.mime)),
      `${file.mime} for .${ext || 'unknown'}`,
    );
    add(`bytes-${file.name}`, file.bytes.byteLength > 0, `${file.bytes.byteLength} bytes`);

    if (!looksLikeText(file.mime, ext)) {
      if (ext === 'pdf') {
        const text = new TextDecoder('latin1').decode(file.bytes);
        add(
          `pdf-${file.name}`,
          text.startsWith('%PDF-') && text.includes('%%EOF'),
          'PDF header and end marker present.',
        );
      }
      continue;
    }

    const text = decode(file.bytes).trim();

    if (ext === 'md') {
      add(`length-${file.name}`, text.length >= 250, `${text.length} characters`);
    }
    if (ext === 'txt') {
      add(`length-${file.name}`, text.length >= 80, `${text.length} characters`);
    }

    if (ext === 'html') {
      const lower = text.toLowerCase();
      add(`html-doctype-${file.name}`, lower.startsWith('<!doctype html>'), 'HTML doctype');
      add(`html-title-${file.name}`, /<title>[^<]+<\/title>/i.test(text), 'Page title');
      add(`html-close-${file.name}`, lower.includes('</html>'), 'Closing html tag');
      add(
        `html-business-${file.name}`,
        !brief.businessName || text.includes(brief.businessName),
        'Business name present',
      );
      add(
        `html-http-${file.name}`,
        !/href\s*=\s*["']http:\/\//i.test(text),
        'No plain-HTTP links',
      );
      add(
        `html-placeholder-${file.name}`,
        !/\{\{|lorem ipsum|\bTODO\b/i.test(text),
        'No unresolved template tokens',
      );
    }

    if (ext === 'csv') {
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      add(`csv-${file.name}`, lines.length >= 2, `${lines.length} rows`);
      add(`csv-header-${file.name}`, /,/.test(lines[0] ?? ''), 'Header row has columns');
    }

    if (ext === 'svg') {
      add(`svg-${file.name}`, text.includes('<svg') && text.includes('</svg>'), 'SVG element present');
    }

    if (ext === 'md') {
      add(`md-heading-${file.name}`, /^#\s+\S/m.test(text), 'Markdown heading present');
      add(
        `md-business-${file.name}`,
        !brief.businessName || text.includes(brief.businessName),
        'Business name present',
      );
    }

    const insecureLinks =
      /href\s*=\s*["']http:\/\//i.test(text) || /\]\(http:\/\//i.test(text);
    add(`http-${file.name}`, !insecureLinks, 'No plain-HTTP content links');
  }

  if (brief.serviceKey === 'website_audit' && brief.website) {
    const report = files.find((file) => file.name.endsWith('.md'));
    add(
      'audit-website',
      Boolean(report && decode(report.bytes).includes(brief.website)),
      'Report names the audited website',
    );
  }

  const failed = checks.filter((check) => !check.pass);
  return {
    verdict: failed.length === 0 ? 'pass' : 'fail',
    checks,
    notes: failed.length === 0 ? null : failed.map((check) => `${check.name}: ${check.detail}`).join('; ').slice(0, 1200),
  };
}
