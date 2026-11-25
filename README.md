# NOVA OS

A native Android AI-agent operating system, built with **React Native + Expo + TypeScript + Expo Router**.

NOVA is the central intelligence. Around it sit six specialists: **ATLAS** (research), **FORGE** (engineering), **ECHO** (marketing), **STERLING** (business), **RELAY** (operations) and **SENTINEL** (quality & safety).

> **Current status: Phase One — the application foundation.**
> The shell, navigation, design system and local workspace are real and working. The AI reasoning core is **not connected yet**, so the app never fakes an agent reply.

---

## What works today

- Native Android app (Expo Router, six-tab navigation, dark futuristic UI).
- **Home** command center: animated NOVA core, live workspace stats, mission control, agent network, real activity log.
- **Chat** layout with message history, suggestions and an honest "core offline" state.
- **Agents** roster with per-agent profiles, capabilities and assigned missions.
- **Missions** board: create, link to a project, advance `queued → active → complete`, delete, filter.
- **Projects** portfolio with progress calculated from completed missions.
- **System** screen: build info, capability status, security notes, local data reset.
- All data is stored **on the device** (AsyncStorage) and survives app restarts.

## What is not implemented yet

- Live AI reasoning and streaming replies (Phase Two).
- Real agent execution, web research, coding tools and approval gates (Phase Three).
- Accounts, cloud sync and multi-device memory.

## Run it

```bash
npm install
npx expo start
```

Scan the QR code with **Expo Go** (Android). A phone and the dev machine must be on the same network, or use `npx expo start --tunnel`.

Useful checks:

```bash
npm run typecheck     # TypeScript, no errors allowed
npx expo-doctor       # dependency / config health
npx expo export --platform android   # proves the Android JS bundle builds
```

## Project structure

```
src/
  app/                    Expo Router routes
    (tabs)/               Home · Chat · Agents · Missions · Projects · System
    agent/[id].tsx        Agent profile
    mission-new.tsx       Mission creation modal
    project-new.tsx       Project creation modal
  components/
    ui/                   AppText, Panel, Screen, NeonButton, Chip, FormField…
    nova/                 NovaOrb, AgentCard, MissionCard, ProjectCard, Composer…
    navigation/           NovaTabBar (custom six-module tab bar)
  data/agents.ts          The agent roster (definitions, not fake activity)
  lib/                    storage, ids, time, core connection status
  store/nova-store.tsx    Persisted workspace state
  theme/                  Colour, spacing, radius and typography tokens
  types/                  Shared domain types
scripts/generate-assets.mjs  Renders the icon, adaptive icon and splash PNGs (npm run assets)
```

## Brand assets

The app icon, Android adaptive icon, splash mark and favicon are **generated**, not hand-drawn:

```bash
npm run assets
```

`npm install` runs this automatically through `postinstall`, so a fresh clone always has
buildable assets. The PNGs are git-ignored to keep the repository text-only; the generator
(`scripts/generate-assets.mjs`) has no dependencies and encodes PNGs with Node's zlib.

## Design language

Black canvas `#04050A`, deep navy panels, neon violet `#8B5CF6`, cyan `#22D3EE`, Space Grotesk for display, Inter for body text, glowing core indicators and restrained motion.

## Security rules

- No API keys are stored in this repository or in the JavaScript bundle.
- `.env` files are git-ignored.
- When the model core is connected, keys will live in the device's encrypted keystore.

## Roadmap

1. **Phase Two — Core intelligence.** Connect an NVIDIA NIM model through an encrypted device keystore, streaming replies, conversation memory, model picker.
2. **Phase Three — Agent execution.** Mission planning, delegation between agents, task monitoring, approval gates, research tools.
3. **Phase Four — Autonomous operations.** Business analysis, content generation, project automation, scheduled missions.
