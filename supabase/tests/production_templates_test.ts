/**
 * Production template + QA smoke test.
 *
 * Run from the repository root:
 *
 *   deno run --allow-net=example.com supabase/tests/production_templates_test.ts
 *
 * Network access is only for the live audit check against example.com. Every
 * other template runs offline. The test uses the same `inspectFiles` function
 * the worker's `sentinel.qa` handler uses.
 */

import {
  generateProductionFiles,
  type ProductionBrief,
} from '../functions/_shared/production/templates.ts';
import { inspectFiles } from '../functions/_shared/production/qa.ts';

const base: ProductionBrief = {
  jobId: '00000000-0000-4000-8000-000000000001',
  title: 'Website audit',
  serviceKey: 'website_audit',
  businessName: 'Leeds Dental Care',
  website: null,
  location: 'Leeds',
  industry: 'dentist',
  contactEmail: 'hello@leedsdental.example',
  scope: 'Review the public website and list the highest-value fixes.',
  deliverables: 'A written report and a prioritised fix list.',
  terms: '50% on acceptance, 50% on delivery.',
  requirements: ['website url'],
  preparedAt: new Date().toISOString(),
};

const keys = [
  'website_audit',
  'landing_page',
  'google_business_profile',
  'content_starter',
  'review_request_kit',
  'enquiry_followup',
  'unknown_service',
];

let failures = 0;

for (const key of keys) {
  const brief = { ...base, serviceKey: key, title: key.replace(/_/g, ' ') };
  const { files } = await generateProductionFiles(brief);
  const qa = inspectFiles(
    files.map((file) => ({ ...file })),
    brief,
  );
  console.log(
    `${key}: ${files.map((file) => `${file.name}(${file.bytes.byteLength})`).join(', ')} -> ${qa.verdict}`,
  );
  if (qa.verdict !== 'pass') {
    failures += 1;
    console.log(qa.notes);
  }
}

const audited = { ...base, website: 'https://example.com' };
const { files, observation } = await generateProductionFiles(audited);
const qa = inspectFiles(
  files.map((file) => ({ ...file })),
  audited,
);
console.log(
  `example.com audit: status=${observation?.status} title=${observation?.title} verdict=${qa.verdict}`,
);
if (qa.verdict !== 'pass') {
  failures += 1;
  console.log(qa.notes);
}

console.log(failures === 0 ? 'GENERATOR_OK' : `GENERATOR_FAILURES=${failures}`);
if (failures > 0) Deno.exit(1);
