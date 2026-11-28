# Phase 6 — Production studio

The roadmap rule: **no pretending text is a file.** A paid order becomes a
production job, FORGE writes real files into private storage, SENTINEL checks the
stored bytes, and only a passing QA row makes a job `READY`.

## The chain

`verified paid order → production_job → forge.produce → stored files → sentinel.qa → ready`

or, while attempts remain, `qa fail → queued → forge.produce (next version)`. After
`max_attempts` the job stops at `needs_attention` with SENTINEL's notes; it never
invents a pass.

## What is enforced

| Rule | Where |
| --- | --- |
| One production job per paid order | `production_jobs.order_id` unique + order trigger |
| The job is created from the order's own quote and lead | `create_production_job_for_order()` |
| A job is enqueued automatically only when production is armed | same trigger + `business_settings.production_enabled` |
| The owner can arm one queued job without touching the queue directly | `start_production()` |
| The app cannot insert files or a QA verdict | table grants: select only for `authenticated` |
| Only the service role uploads and records QA | grants to `service_role`; handlers use the admin client |
| Files are private and owner-scoped | `deliverables` bucket + storage policy on the owner folder |
| Versions are append-only | `production_files (job_id, version, name)` and path unique |
| Retries are bounded | `attempts <= max_attempts`, default 3 |
| A job cannot be started twice for the same version | version-based enqueue key |
| Another owner cannot read the job, files or QA | RLS by `owner_id` |

## Templates that produce files

| Service key | Files |
| --- | --- |
| `website_audit` | `website-audit.md`, `website-audit.pdf`, `fix-list.csv` |
| `landing_page` | `index.html`, `landing-copy.md` |
| `google_business_profile` | `profile-setup.md`, `profile-description.txt` |
| `content_starter` | `content-calendar.csv`, `posts.md`, `social-card.svg` |
| `review_request_kit` | `review-request-kit.md`, `review-request-email.txt` |
| `enquiry_followup` | `enquiry-follow-up.md`, `sequence.csv` |
| anything else | `deliverable.md`, `handover-checklist.md` |

The PDF is written by a small PDF 1.4 generator in `templates.ts`: Helvetica,
automatic pagination, a real `%PDF-` header and `%%EOF` trailer.

### The website audit is a real observation

When the lead has a public HTTPS website, the generator makes **one** GET request
and reports only what it saw: HTTP status, response time, title, meta description,
mobile viewport, H1 count, images without alt text, link count, plain-HTTP links,
word count and HTML size. The report states that no browser rendering happened.

The fetch refuses non-HTTPS URLs, localhost and lookalike names, `.local`,
`.internal`, `.home.arpa`, IP literals and hostnames without a dot. Redirects are
followed manually for at most three hops and each hop is re-validated, so a public
URL cannot redirect the worker into a private address. The response is capped and
times out after 12 seconds.

When the site cannot be fetched, the report says exactly why and claims no
on-page finding. When there is no website at all, the audit is a worksheet that
says no page was checked.

## SENTINEL's checks

For every stored file of the current version:

- at least two files, with at least one primary deliverable
- the MIME type matches the extension
- HTML starts with `<!doctype html>`, has a title and closes, carries the
  business name, contains no `http://` link and no unresolved template token
- Markdown has a heading, at least 250 characters and the business name
- CSV has a header and at least two rows
- PDF starts with `%PDF-` and ends with `%%EOF`
- SVG contains a complete `<svg>` element
- text files contain no plain-HTTP links and no lorem ipsum/TODO
- a website audit names the audited URL

A failed check stores `production_qa` with `verdict = fail`, the individual
checks, and returns the job to production with those notes. The next generation
bumps the version. The Studio shows the verdict and the notes; nothing marks the
work ready by hand.

## The app

`src/app/studio.tsx`:

- arms or disarms production for the owner
- lists paid-order jobs with status, version and attempt count
- shows the current version's files, size and a one-hour signed link
- shows SENTINEL's last verdict and QA notes
- **Start production** / **Retry production** for a queued or needs-attention job
- links to Delivery

The Company screen links to Studio. Production is off by default; an order still
creates its job while off, so no paid work is lost.

## Storage

Migration `20261128150000_phase6_production.sql` creates the private
`deliverables` bucket and the owner-read policy **when the `storage` schema
exists** (a real Supabase project). The guard keeps the plain-Postgres suite
working. No manual bucket step is needed; deploy the migration before production.

Paths are `${owner_id}/${job_id}/v${version}/${name}`. The app never uploads and
only reads its own folder through a signed URL.

## What the SQL suite asserts

The local Postgres suite applies every migration and now runs **68 assertions**
(48 existing + 20 new). The Phase 6 and completion ones:

- an owner can schedule a follow-up on a sent message
- a second open follow-up and another owner's attempt are refused
- a reply cancels the open follow-up; suppression cancels it too
- a quote stores deliverables, terms, requirements and discount
- a verified paid order creates exactly one production job
- production is off by default and `start_production` refuses while off
- `start_production` moves the job to `generating` and queues `forge.produce`
- a started job cannot be started twice
- another owner sees no production jobs, files or QA
- the app cannot insert a production file
- the service role can record a file and a QA verdict
- the owner can read their files; another owner cannot

## Generator smoke test

`supabase/tests/production_templates_test.ts` generated every template and ran the
same QA function the worker runs: all eight cases passed. Run it from the repo
root with:

```bash
deno run --allow-net=example.com supabase/tests/production_templates_test.ts
```

It also fetched
`https://example.com` for a live audit (HTTP 200, title "Example Domain") and the
result passed QA, including the PDF header/trailer check.

## What is not built

- **No delivery.** Studio marks a job ready; the delivery email, secure download
  page, customer acceptance and retention follow-ups are Phase 7.
- **No customer revision loop.** A revision request creates a new production
  version only once Phase 7 wires it.
- **No browser-rendered QA.** SENTINEL opens no browser: it cannot see layout,
  JavaScript errors or mobile rendering. The audit is one HTML request.
- **No server-side model calls.** Copy is deterministic template copy from the
  accepted brief. NVIDIA NIM is still the app's model provider, not a production
  writer.
- **No live Supabase run.** The bucket, uploads, signed URLs and the handlers
  were not executed against a deployed project (no project credentials here).
  The schema, RLS and grants were exercised on local Postgres; the generator and
  QA were exercised directly.
- **No flyers, menus or branding.** Those services are not in the approved
  catalog, so no template pretends to sell them.
