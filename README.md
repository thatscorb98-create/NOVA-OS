# NOVA OS

A native Android AI-agent operating system, built with **React Native + Expo + TypeScript + Expo Router**.

NOVA is the central intelligence. Around it sit six specialists: **ATLAS** (research & analysis), **FORGE** (engineering), **ECHO** (marketing & content), **STERLING** (business strategy), **RELAY** (operations) and **SENTINEL** (quality & safety).

> **Current status: Phase Two — the agent workforce.**
> All seven agents make real NVIDIA NIM model calls. NOVA delegates work to specialists through tool calls, and every result is persisted on the device. Nothing is scripted or simulated: with no API key, the app says the core is offline instead of inventing an answer.

---

## What works today

- Native Android app (Expo Router, six-tab navigation, dark futuristic UI).
- **Seven agents**, each with its own role, system instructions, personality, temperature, tool set and persistent memory.
- **NOVA delegation**: NOVA calls a `delegate_task` tool; the chosen specialist runs with its own prompt and memory, the mission and result are stored, and NOVA reports back what actually happened.
- **Agent management screen** per agent: enable/disable switch, direct chat, assign-and-run task form, delivered work list, memory viewer/editor.
- **Mission detail** screen: objective, status, the stored model output, the real tool/delegation steps, model id and duration, plus run/re-run and manual completion.
- **Core settings**: bring-your-own NVIDIA NIM key stored in the device keystore, model selector, live connection test.
- **Chat** with NOVA wired to live model calls, a working indicator and honest error messages (rate limits, rejected key, retired model).
- **Local-first persistence** for missions, projects, conversations, memory, activity and settings; data survives restarts.

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

## What is not implemented yet

- Web browsing, file access and code execution tools for agents (they reason from model knowledge and the stored workspace).
- Streaming replies; calls are non-streaming for reliability on mobile networks.
- Accounts, cloud sync and multi-device memory.

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
    agent/[id].tsx        Agent management console (overview · work · chat)
    mission/[id].tsx      Mission detail and stored result
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
    tools.ts              Tool schemas exposed to the model
  lib/storage.ts          AsyncStorage persistence with v1 → v2 migration
  store/nova-store.tsx    Local workspace state (missions, memory, threads, settings)
  store/agent-runtime.tsx Real model calls, tool execution, delegation, persistence
  types/nova.ts           Domain types
```

## How a delegation works

1. You message NOVA (or assign a task to an agent directly).
2. NOVA receives its system prompt plus workspace context and memory, with the `delegate_task` tool available.
3. The model returns a tool call naming a specialist and a task brief.
4. The runtime creates a real mission, runs that specialist with its own instructions, memory and workspace access, and stores the output.
5. The specialist's result is returned to NOVA as a tool message; NOVA writes the final report.
6. The mission, result, steps, conversation and memory note are persisted on the device.

Every step above is a real request. Failures (invalid key, rate limit, retired model, disabled agent) surface as explicit messages and never produce a fabricated result.

## Security

- No API keys in the repository, the bundle or the chat.
- The key lives in the platform keystore and is used only for provider requests.
- Model output is advice, not verified fact; the UI repeats this before you act on it.
- All workspace data is local to the device and can be wiped from **System → Reset local workspace** (the stored key is kept until you remove it in Core settings).

## Brand assets

`assets/*.png` are generated, not committed:

```bash
npm run assets
```

`postinstall` runs the generator automatically, so a fresh `npm install` produces the icon, adaptive icon, splash, monochrome and favicon files.
