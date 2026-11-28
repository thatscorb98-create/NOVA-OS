# Changelog

All notable changes to NOVA OS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow semantic versioning. Every Android build carries the `versionCode` from `app.json`.

## [0.4.0] — 2026-11-28

Fourth Android release (`versionCode` 4).

### Added

- **Private delivery links (Phase 7).** A random 32-byte token is stored only as
  a SHA-256 hash with an expiry; the customer's page signs each stored file for
  15 minutes and never exposes the bucket. Links can be revoked, and expired,
  revoked and unknown tokens all return the same page.
- **Delivery email.** `relay.send_delivery` mints the link, sends a transactional
  email through AgentMail and marks the delivery delivered only after a provider
  message id comes back. A failed send leaves the delivery open for a retry.
- **Revision re-production.** Asking for a revision re-arms the paid order's
  production job, resets its attempt budget, queues FORGE for the next version
  and keeps the customer's note in the QA trail.
- **Retention.** A delivered customer can be scheduled for an owner-approved
  30-day check-in; replies, bounces and suppressions cancel it.
- **Customer history.** One row per paying customer with orders, paid value,
  deliveries, acceptances and the last delivery date.

## [0.3.0] — 2026-11-28

Third Android release (`versionCode` 3).

### Added

- **Production studio (Phase 6).** A verified paid order creates a production
  job. FORGE writes real files from the accepted brief — Markdown, HTML, CSV,
  SVG and a real PDF — into the private `deliverables` bucket. SENTINEL checks
  the stored bytes for type, structure, PDF markers, the business name, links and
  unresolved tokens, and only a passing QA row makes a job ready. Failures return
  to production with notes for at most three attempts.
- **Website audit.** A public HTTPS page is fetched once and reported exactly as
  observed: status, timing, title, description, viewport, headings, image alt
  text, links and size. Private hosts, IP literals and unsafe redirects are
  refused.
- **Studio screen.** Jobs, versions, attempts, QA notes, one-hour signed file
  links and the production arm/disarm switch.
- **Follow-ups (Phase 3).** A sent message can be scheduled for a check-in. A
  reply, bounce or suppression cancels it automatically, and a due follow-up can
  become an owner-approved draft.
- **Routine reply drafts (Phase 3).** CLOSER drafts a reply from the stored
  intent and lead facts; it waits in Outreach for approval and nothing sends
  automatically.
- **Quote terms (Phase 4).** Quotes now carry deliverables, terms, requirements
  and a discount, and the acceptance page shows them next to the price.

## [0.2.0] — 2026-11-28

Second Android release (`versionCode` 2).

### Added

- **Stripe checkout (Phase 5).** An accepted quote with payments switched on can
  open a Stripe Checkout Session from the app. The session is created server-side;
  the secret key never reaches the bundle.
- **Verified payments.** A paid record exists only after `stripe-webhook` verifies
  the HMAC signature and `record_stripe_event` matches the amount and currency.
  Duplicate events are idempotent, and an order is created exactly once.
- **Refunds.** `charge.refunded` updates the payment and the order to partial or
  full refund without inventing a second payment.
- **Finance screen.** Gross and net revenue, pending money, refunds, recorded
  expenses, AI spend, profit, payment records and paid orders.
- **Expenses.** The owner records real costs; profit is revenue minus those costs
  and the recorded AI spend.
- **Live-mode switch.** Off by default; a live Stripe key is refused while it is
  off.

## [0.1.0] — 2026-11-25

First installable Android release (`versionCode` 1).

### Added

- **Mission execution.** A goal given to NOVA is planned into up to five tasks, each assigned to a real specialist, reviewed by SENTINEL, retried once when the review asks for it, and closed with a final report written from the actual task outputs.
- **Mission dashboard.** Goal composer, approval queue, live task queue, progress bars, filters and per-mission status, all backed by persisted state.
- **Approval gates.** Review-mode missions wait at `awaiting_approval` before any specialist runs; a blocked task or an expired run window raises a decision to retry, accept the failure or cancel.
- **Mission console.** Plan and task states, per-task output, review verdicts, retry controls, the final report, call usage, limits and the full execution timeline.
- **Memory.** One local ledger in four scopes (global, project, agent, conversation) with relevance-based recall into every prompt, agent-driven `save_memory` / `recall_memory`, and automatic writes after missions and chats.
- **Agent network.** Seven agents (NOVA, ATLAS, FORGE, ECHO, STERLING, RELAY, SENTINEL) with their own instructions, personality, temperature and memory, plus a per-agent console to enable, chat, assign work and manage memory.
- **Core settings.** Bring-your-own NVIDIA NIM key stored in the Android Keystore, model selection from a verified allowlist, and a live connection test.
- **Local-first storage.** Missions, projects, conversations, memories, activity and settings persist on the device; state migrates forward from v1–v3 to the v4 schema.

### Execution limits

- 5 tasks per mission, 2 attempts per task, 24 model calls per mission, an 8-minute run window and a 60-step hard loop bound. The call budget is persisted and checked before every request, so a run cannot loop or spend without end.

### Android packaging

- Standalone release APK configuration for `com.novaos.app`: app name NOVA OS, `versionCode` 1, adaptive icon, monochrome icon and splash screen on `#04050A`, portrait only.
- Minimal permissions — the app requests `INTERNET` and `VIBRATE`; library manifests contribute a signature-level `DUMP` and normal-level biometric declarations, and the template's storage and overlay permissions are explicitly blocked.
- `expo-secure-store` with Android backup exclusion, so the model key is never included in cloud backups.
- Free cloud builds: a GitHub Actions workflow that produces a signed release APK with no computer, and `eas.json` `preview` (APK) / `production` (AAB) profiles for Expo's free tier. The workflow builds arm64-v8a only and publishes the finished APK to a public download link.
- `.npmrc` relaxes peer resolution so installs work with the pinned React 19.3.0.

### Notes

- The APK is signed with the Expo template's debug keystore: fine for sideloading, not for Google Play.
- Bump `android.versionCode` in `app.json` for each new release; Android installs an update only when the version code is higher.
