# Phase 6 — production and delivery

Phase 6 tracks work that has been agreed and must now be delivered. It does not
generate the work, and it cannot claim a delivery happened.

## The chain

`accepted quote → delivery opened → in progress → delivered → accepted`

or, while the revision allowance lasts, `delivered → revision requested → in
progress → delivered`.

Every transition is a database function; the app only reads `deliverables`.

- `open_delivery(quote)` — owner only. The quote must be accepted. When
  `business_settings.payments_live` is true, a succeeded payment record for that
  quote is also required. The due date is `accepted_at + delivery_days`, and the
  revision allowance comes from the quoted service's `revisions` (default 1).
  A second delivery for the same quote is refused.
- `start_deliverable(id)` — `pending` or `revision_requested` → `in_progress`.
- `mark_deliverable_delivered(id, url)` — requires an `http(s)` link to the
  actual work. The status, timestamp and URL are written together, so a delivery
  cannot exist as a status without evidence.
- `accept_deliverable(id)` — only a delivered item. It records `accepted_at` and
  moves the linked deal to `won`. This is the only automatic deal stage change,
  and it rests on a delivery the owner just accepted.
- `request_deliverable_revision(id, note)` — only a delivered item, only while
  `revisions_used < revisions_included`, and the note must say what to change.
  The counter cannot exceed the allowance: a table check enforces it as well.

## The app

`src/app/delivery.tsx`:

- lists accepted quotes that have no delivery yet, with **Open delivery**
- lists open work with **Start work**, **Mark delivered** (a link field),
  **Accept** and **Request revision** (a note field)
- shows the artifact link and the current revision note
- footer links to Quotes and Pipeline

`/quotes` also links to the screen.

## What the SQL suite asserts

- a delivery cannot be opened from a quote that is not accepted
- opening an accepted quote produces a due date and the service's revisions
- opening the same quote twice is refused
- with payments live, delivery needs a succeeded payment record
- marking delivered without a real URL is refused
- delivery records the URL and timestamp
- acceptance is refused before delivery, then marks the deal won
- a revision request needs a note and increments the used count
- a revision beyond the allowance is refused
- another owner cannot read or open deliveries

## What is not built

- No production tooling. Nothing generates a website, copy or report; the
  deliverable is produced by the owner (or a future agent) outside this schema,
  and the URL is the evidence that it exists.
- No receipts, invoices, refunds or customer-facing delivery page.
- No customer acceptance portal: acceptance here is the owner recording that the
  customer accepted.
- Nothing has been run against a deployed project. The functions were exercised
  on a local Postgres built from the migrations.
