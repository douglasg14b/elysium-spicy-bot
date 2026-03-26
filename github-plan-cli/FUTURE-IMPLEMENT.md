# Future: `@jarvis implement` (sketch)

This document describes how **plan execution** could mirror the same patterns as intent classification and plan generation—without implementing them yet.

## Goals

- **Code-first orchestration** in `github-plan-cli`: checkout branch, parse machine-readable steps from `.jarvis/plan.md` (or a sidecar JSON/YAML you add later), run deterministic scripts, then optionally one bounded Cursor `agent` pass with **file-only** outputs.
- **Workspace profiles**: use **`repo`** workspace for edits; use **`minimal`** only for subprocesses that do not need the codebase (e.g. summarization).
- **No stdout chaining**: each stage reads/writes agreed paths under `.jarvis/` or the repo root.
- **Telemetry**: reuse `recordAgentTelemetryStep` after each `spawnCursorAgent` call.

## Suggested flow

1. Gate on classified intent **`implement`** (extend workflow + `DETECTOR_INTENT_VALUES` when ready).
2. Checkout the plan branch (or a dedicated `implement/*` branch).
3. **Deterministic preflight**: `pnpm install`, `pnpm build`, `pnpm test` as appropriate—driven by config, not the LLM.
4. **Optional agent step**: prompt loaded via `loadPrompt`, `--workspace` = repo root, require writes only to defined artifact files for review.
5. Open a PR or push; post a thread comment with links and logs.

## Entry point

When implemented, wire `pnpm github-plan plan implement` to a real runner and replace `runImplementPlanStub`.
