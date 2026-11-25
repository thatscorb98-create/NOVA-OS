# Changelog

All notable changes to NOVA OS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow semantic versioning. Every Android build carries the `versionCode` from `app.json`.

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
- Minimal permissions — `INTERNET` and `VIBRATE`; the template's storage and overlay permissions are explicitly blocked.
- `expo-secure-store` with Android backup exclusion, so the model key is never included in cloud backups.
- Free cloud builds: a GitHub Actions workflow that produces a signed release APK with no computer, and `eas.json` `preview` (APK) / `production` (AAB) profiles for Expo's free tier.
- `.npmrc` relaxes peer resolution so installs work with the pinned React 19.3.0.

### Notes

- The APK is signed with the Expo template's debug keystore: fine for sideloading, not for Google Play.
- Bump `android.versionCode` in `app.json` for each new release; Android installs an update only when the version code is higher.
