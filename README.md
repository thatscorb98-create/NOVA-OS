# NOVA OS

A native Android AI-agent operating system, built with **React Native + Expo + TypeScript + Expo Router**.

NOVA is the central intelligence. Around it sit six specialists: **ATLAS** (research & analysis), **FORGE** (engineering), **ECHO** (marketing & content), **STERLING** (business strategy), **RELAY** (operations) and **SENTINEL** (quality & safety).

> **Current status: Phase Four — mission execution.**
> Give NOVA a goal and it plans the work, delegates each task to a specialist, reviews what comes back, retries failures and writes a final report. Runs are gated by approvals and hard budgets, and memory from previous missions is recalled into every prompt. Nothing is scripted: with no API key the app says the core is offline instead of inventing an answer.
>
> **Cloud foundation:** discovery, outreach, quotes, payment records, the reply pipeline and delivery tracking are built and checked against a local Postgres. No Supabase project is configured for this repository, so no edge function has run against a live backend, and nothing has been emailed, charged or delivered.

---

## What works today

- Native Android app (Expo Router, six-tab navigation, dark futuristic UI).
- **Seven agents**, each with its own role, system instructions, personality, temperature, tool set and memory.
- **NOVA delegation**: NOVA calls a `delegate_task` tool; the chosen specialist runs with its own prompt and memory, the mission and result are stored, and NOVA reports back what actually happened.
- **Agent management console** per agent: enable/disable switch, direct chat, assign-and-run task form, delivered work list and memory controls.
- **Persistent memory** in four scopes: global, project, agent and conversation.
  - Relevant memories are recalled into the prompt on every turn; pinned memories are always included.
  - Agents can save and search memory themselves with `save_memory` and `recall_memory`.
  - Completed missions write agent memory (and project memory when the mission is linked to a project).
  - Every substantive chat exchange is recorded as a conversation memory.
- **Memory screen**: search, filter by scope, add, edit, pin and delete anything that was saved.
- **Mission execution**: NOVA plans a goal into up to five tasks, assigns each to the right specialist, reviews every deliverable, retries failures and produces a final report.
- **Mission dashboard**: goal entry, approval queue, live task queue, progress bars and execution history.
- **Approval gates**: approve the plan before any specialist runs, or stop on a blocked task and choose retry, accept or cancel.
- **Hard budgets**: five tasks, two attempts per task, 24 model calls and an eight-minute run window per mission, with a 60-step loop cap.
- **Mission detail** screen: plan and task states, per-task output, review verdicts, real tool/delegation steps, model, duration, report and re-run.
- **Core settings**: bring-your-own NVIDIA NIM key in the device keystore, model selector, live connection test.
- **Local-first persistence** for missions, projects, conversations, memories, activity and settings; data survives restarts and older state is migrated forward.

## Connect the model

1. Create a free key at **https://build.nvidia.com/settings/api-keys**.
2. In the app open **System → Core** (or tap the avatar on Chat).
3. Paste the key, save, then tap **Test**.

The key is stored with `expo-secure-store` (Android Keystore) and sent only to `integrate.api.nvidia.com` as a Bearer token. It is never committed, bundled or written to the workspace database.

Available models (verified live on the NIM endpoint, all with tool calling):

| Model | Use |
| --- | --- |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Default: fast, agentic, tool calling |
| `nvidia/nemotron-3.5-bolt-e4b` | Compact tool calling |
| `nvidia/nemotron-3-ultra-550b-a55b` | Deep reasoning, slower |
| `z-ai/glm-5.3-flash` | Fast general model |

The free developer tier is rate limited to roughly 40 requests per minute. A delegation costs several requests: NOVA plans, the specialist works, NOVA summarises.

## How memory works

Memory is one local ledger (`MemoryRecord[]`), not a per-agent note pile. Each record has:

| Field | Meaning |
| --- | --- |
| `scope` | `global`, `project`, `agent` or `conversation` |
| `kind` | `fact`, `preference`, `decision`, `summary` or `note` |
| `source` | Who wrote it: you, an agent, NOVA, a mission or a chat |
| `agentId` / `projectId` | The agent or project the memory belongs to |
| `pinned` | Always included in prompts when true |
| `createdAt` / `updatedAt` | Real timestamps, shown in the UI |

**Recall** happens in `src/lib/memory.ts`: token overlap with the current message, plus bonuses for the active agent, the linked project, preferences and decisions, pinned entries, and recency. The top matches (bounded to ~2.4k characters) are inserted into the system prompt with their scope labels. With no query, pinned and recent memories are used. Agents can also search explicitly through the `recall_memory` tool.

**Writes** happen from three real sources:

1. You, on the Memory screen or an agent's overview.
2. Agents, through `save_memory` while working.
3. The runtime, after a mission completes (agent memory, plus project memory when linked) and after each substantive chat exchange (conversation memory).

Duplicate text in the same scope and owner refreshes the existing record instead of adding another. The ledger keeps 600 records and prunes the oldest **unpinned** ones, so pinned knowledge is never silently dropped. Deleting a project promotes its project memories to global rather than losing them.

### Storage

Memory lives in **AsyncStorage on the phone**, the same durable store used for missions, projects and chat history. It is written on every change and survives closing the app, rebooting and reinstalling only if the OS keeps app data. It is not in-memory state and does not reset when the app closes.

Cloud or GitHub-backed storage was deliberately not used: every option would need an account, an API key or a token shipped inside the app, which contradicts the no-secrets rule and would expose private memory to a third party. Recall is local, free and works offline. The cost is that memory is per-device — moving phones means exporting it, which is not implemented yet.

## How mission execution works

A **planned mission** is NOVA coordinating specialists toward one goal.

1. **Plan.** NOVA receives the goal, the linked project, the workspace and recalled memory, and must return strict JSON: up to five tasks, each with a title, a self-contained brief, one real specialist and dependencies on earlier tasks. The parser rejects unknown agents, NOVA itself, empty briefs and forward dependencies.
2. **Approve.** With *Review plan first*, the mission stops at `awaiting_approval` and nothing runs until you approve. With *Auto-run* it continues immediately.
3. **Delegate.** Each task whose dependencies are complete runs with that specialist's own instructions, temperature and recalled memory, plus the outputs of earlier tasks.
4. **Review.** SENTINEL reviews the output against the brief and returns `pass` or `retry`. A retry adds the reviewer's notes to the brief and runs the task once more.
5. **Escalate.** If a task still fails, or the run window expires, the mission stops in `awaiting_approval` with a decision: retry the task, accept the failure and continue, or cancel.
6. **Report.** NOVA writes the final report from the real task outputs: outcome, delivered work, issues and next actions. The report, task outputs, reviews, call usage and the whole execution timeline are stored on the device.

### Limits

| Limit | Value | Where |
| --- | --- | --- |
| Tasks per mission | 5 | `MISSION_LIMITS.maxTasks`, plan parser |
| Attempts per task | 2 | task `maxAttempts`, retry loop |
| Model calls per mission | 24 | checked before every call |
| Run window | 8 minutes | checked between tasks, resumable |
| Loop iterations | 60 | hard `for` bound, no `while(true)` |

The call budget is persisted on the mission and incremented before every request, including planning, review and the report. When it is reached the mission stops and reports why — it cannot keep spending. There is no automatic replanning: a failed plan returns to `queued` so you decide whether to run it again.

## What is not implemented yet

- Web browsing, file access and code execution tools for agents (they reason from model knowledge and stored memory).
- Streaming replies; calls are non-streaming for reliability on mobile networks.
- Parallel task execution: planned tasks run one at a time to keep costs and rate limits predictable.
- Automatic replanning when a whole plan fails; you retry or start a new mission instead.
- Multi-device memory sync. Phase 1 adds optional owner accounts and a cloud queue, but the local ledger is not mirrored automatically.
- Live email and payments. Both have their backend and screens, but they ship switched off, no provider key is configured, and nothing has been sent or charged. Payment records say what is owed; there is no charge call in the codebase.
- Automatic production. Delivery tracking records the work and the link to it, but no tool generates the deliverable and nothing is sent to a customer automatically.
- Inbox sync. Replies are only recorded when the email provider POSTs to the webhook; the app does not poll a mailbox.
- Memory export/import.

## Run it

```bash
npm install
npx expo start
```

Scan the QR code with **Expo Go** (Android), or run `npx expo start --tunnel`.

Useful checks:

```bash
npm run typecheck                     # TypeScript, no errors allowed
npx expo-doctor                       # dependency / config health
npx expo export --platform android    # proves the Android JS bundle builds
```

## Build the APK and install it on your phone

No computer is required. The repository carries a free cloud build (`.github/workflows/android-apk.yml`) that produces a signed release APK on GitHub's servers, and `eas.json` for Expo's own free tier.

### Option A — GitHub Actions (free, phone only)

1. Open the repository on **github.com** in your phone's browser and sign in.
2. Tap **Actions** → **Build Android APK** → **Run workflow** → **Run workflow**.
3. Wait roughly 10–20 minutes for the run to finish with a green tick.
4. Open that run and download the **nova-os-apk** artifact.
5. Unzip the download with the Files app or ZArchiver — it contains `nova-os.apk`.
6. Tap the APK. Android asks once for permission to install unknown apps: allow it for the app you opened the file from, then tap **Install**.

Builds are signed with the same keystore every run, so a newer APK installs straight over an older one and your missions and memory are kept.

### Option B — EAS Build (Expo's free tier)

```bash
npx eas-cli@latest login
npx eas-cli@latest build --platform android --profile preview
```

`preview` produces an installable APK (`"buildType": "apk"`); `production` produces an `.aab` for Google Play. EAS generates and stores the Android keystore on the first build and prints a download link and QR code when the build finishes. Both options are free for personal use — queued builds on EAS can take a while, GitHub Actions builds start immediately.

### What the configuration sets

| Setting | Value |
| --- | --- |
| App name | NOVA OS |
| Package | `com.novaos.app` |
| Version / code | `0.1.0` / `1` (`versionCode` in `app.json`) |
| Permissions | `INTERNET`, `VIBRATE` — nothing else is requested |
| Icon | 512×512 (above every Android density bucket), plus adaptive foreground and monochrome layers on `#04050A` |
| Splash | Generated mark on `#04050A`, 220 px wide, dark mode identical |
| Secure storage | `expo-secure-store`, Android Keystore, excluded from cloud backup |
| Signing | Debug keystore from the Expo template (sideloading only, not Play Store) |

The APK is self-contained: the JavaScript bundle and fonts are inside it, so it runs without Metro. Only model requests need a connection.

Bump `android.versionCode` in `app.json` before each new release you hand out; Android installs an update only when the version code is higher.

## Project structure

```
src/
  app/                    Expo Router routes
    (tabs)/               Home · Chat · Agents · Missions · Projects · System
    agent/[id].tsx        Agent console (overview · work · chat)
    mission/[id].tsx      Mission detail and stored result
    memory.tsx            Memory ledger: search, add, edit, pin, delete
    core.tsx              Model key, model choice, connection test
    mission-new.tsx       Mission creation modal
    project-new.tsx       Project creation modal
  components/
    ui/                   AppText, Panel, Screen, NeonButton, Chip, FormField…
    nova/                 NovaOrb, AgentCard, MissionCard, MessageBubble, Composer…
    navigation/           NovaTabBar (custom six-module tab bar)
  data/agents.ts          Agent roster: prompts, personality, tools, temperature
  lib/model/
    client.ts             NVIDIA NIM OpenAI-compatible client + typed errors
    models.ts             Verified model allowlist
    secure-key.ts         Keystore-backed API key storage
    tools.ts              Tool schemas (delegate, mission, memory, recall)
  lib/memory.ts           Tokenizer, relevance scoring, prompt formatting, search
  lib/mission.ts          Plan parsing, task graph, progress and hard limits
  lib/storage.ts          AsyncStorage v4 state with v1/v2/v3 migration
  store/nova-store.tsx    Workspace state and the memory ledger
  store/agent-runtime.tsx Model calls, tools, delegation, memory writes
  types/nova.ts           Domain types
```

## How a delegation works

1. You message NOVA (or assign a task to an agent directly).
2. NOVA receives its system prompt, workspace context and recalled memory, with the `delegate_task` tool available.
3. The model returns a tool call naming a specialist and a task brief.
4. The runtime creates a real mission, runs that specialist with its own instructions, memory and workspace access, and stores the output.
5. The specialist's result returns to NOVA as a tool message; NOVA writes the final report.
6. Mission, result, steps, conversation and memory are persisted on the device.

Every step above is a real request. Failures (invalid key, rate limit, retired model, disabled agent) surface as explicit messages and never produce a fabricated result.

## Security

- No API keys in the repository, the bundle or the chat.
- The key lives in the platform keystore and is used only for provider requests.
- Memories and conversations stay on the phone; the only outbound data is the prompt sent to NVIDIA for the current turn.
- Model output is advice, not verified fact.
- **System → Reset local workspace** wipes missions, projects, conversations and memories (the stored key is kept until you remove it in Core settings).

## Cloud foundation (Phase 1)

The app still works entirely on the phone with no account. Connecting a Supabase project adds the parts that cannot live on a phone: a persistent job queue that survives the app being closed, a worker and scheduler that run server-side, company memory, and the CRM tables later phases build on.

- `supabase/migrations/` — schema, row level security, queue RPCs.
- `supabase/functions/worker` — claims and runs jobs, with retries, checkpoints and recovery.
- `supabase/functions/scheduler` — cron entry point that enqueues the recovery sweep and drains the queue.
- `src/app/cloud.tsx` — the control surface: sign in, health, queue, worker controls, company mode.

Setup steps, what is enforced, and known limits are in [`docs/phase-1-cloud-foundation.md`](docs/phase-1-cloud-foundation.md).

Later cloud phases, each with its own evidence and limits:

- [`docs/phase-2-and-3.md`](docs/phase-2-and-3.md) — discovery, scoring, outreach drafts and the send gates.
- [`docs/phase-4-quotes.md`](docs/phase-4-quotes.md) — quotes, signed acceptance links and payment records.
- [`docs/phase-5-pipeline.md`](docs/phase-5-pipeline.md) — reply capture, suppression, the deal pipeline and the ready-to-draft query.
- [`docs/phase-6-production.md`](docs/phase-6-production.md) — delivery tracking, evidence, acceptance and bounded revisions.

### Quotes, acceptance and payment records (Phase 4)

The owner writes a quote and the amount; NOVA never guesses a price. `send_quote`
releases it, and the acceptance link carries an HMAC over the quote id and an
expiry, signed server-side with `QUOTE_LINK_SECRET` (falling back to
`WORKER_SECRET`). `accept_quote` is service-role only and requires a sent,
unexpired quote. Only after that can `create_payment_intent` record an amount
owed — and only when payments are switched live. A record starts as
`requires_payment`; `succeeded` is refused without a provider reference. There
is no charge call in the codebase.

### Replies, suppression and the pipeline (Phase 5)

Provider webhooks land in `record_email_event`, which resolves the message from
our own row, appends the event, attaches a deterministic keyword intent and
suppresses the address on an opt-out, bounce or complaint. A reply moves the
message and the deal, and an opt-out closes the deal as `do_not_contact`. The
intent is shown as a hint, not a claim about what the customer meant.

The **Ready to draft** list is decided by the database (`ready_to_draft_leads`),
not by a page of contacts loaded on the phone. It looks at every contact the
owner has, applies the opt-out and suppression rules, skips leads with an open
draft, and returns one address per lead, 100 at a time with a `total_count` for
the whole set. The screen shows "_n_ of _total_" and a button that loads the next
page, so a lower-scored lead is never hidden without saying so.
`ready_to_draft_stats` reports how many are ready and how many are waiting on a
usable address, without loading either list.

### Delivery (Phase 6)

An accepted quote can be opened as a delivery, with a due date taken from its
delivery days and the revision allowance from the service. Marking work
delivered requires an `http(s)` link to the actual artifact; acceptance is the
owner's own action and marks the deal `won`; revision requests are bounded by
the included allowance. When payments are live, delivery cannot start until a
succeeded payment record exists. The app can read deliverables but every
transition goes through a database function.

`.github/workflows/supabase-deploy.yml` deploys **every** directory under `supabase/functions` that has an `index.ts`; `_shared` is imported, not deployed on its own. The list is discovered at run time, so a new function is never left out of a deployment.

Only the public anon key reaches the app. The service-role key is read by the edge functions from Supabase secrets and never appears in the bundle, the repository or a log.

## Brand assets

`assets/*.png` are generated, not committed:

```bash
npm run assets
```

`postinstall` runs the generator automatically, so a fresh `npm install` produces the icon, adaptive icon, splash, monochrome and favicon files.
