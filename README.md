# NOVA OS

A native Android AI-agent operating system, built with **React Native + Expo + TypeScript + Expo Router**.

NOVA is the central intelligence. Around it sit six specialists: **ATLAS** (research & analysis), **FORGE** (engineering), **ECHO** (marketing & content), **STERLING** (business strategy), **RELAY** (operations) and **SENTINEL** (quality & safety).

> **Current status: Phase Three — persistent memory.**
> All seven agents make real NVIDIA NIM model calls, NOVA delegates work through tool calls, and the system now remembers across sessions. Memory is stored on the device, survives restarts, and is recalled into every relevant prompt. Nothing is scripted: with no API key the app says the core is offline instead of inventing an answer.

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
- **Mission detail** screen: stored model output, real tool/delegation steps, model, duration, re-run.
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

## What is not implemented yet

- Web browsing, file access and code execution tools for agents (they reason from model knowledge and stored memory).
- Streaming replies; calls are non-streaming for reliability on mobile networks.
- Accounts, cloud sync and multi-device memory.
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
  lib/storage.ts          AsyncStorage v3 state with v1/v2 migration
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

## Brand assets

`assets/*.png` are generated, not committed:

```bash
npm run assets
```

`postinstall` runs the generator automatically, so a fresh `npm install` produces the icon, adaptive icon, splash, monochrome and favicon files.
