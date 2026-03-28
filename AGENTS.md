# Agent brief — discord-spicy-bot

Discord bot (discord.js v14, ESM TypeScript). Entry: `src/bot.ts` → `DISCORD_CLIENT.login`; slash/components/modals route through `InteractionsRegistry` (`src/features-system/commands/interactionsRegistry.ts`). Feature modules call `init*()` to register handlers and side effects; some commands also registered in `bot.ts`.

## Stack

| Area               | Choice                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node, `"type": "module"`, `tsx` for dev                                                                              |
| Discord            | discord.js, CommandKit for slash scaffolding where used                                                              |
| DB                 | Kysely + **sqlite** (`better-sqlite3`) or **postgres** (`pg`); dialect from `DB_TYPE`                                |
| Validation / types | Zod; `@eicode/result-pattern` for Result-style flows                                                                 |
| AI                 | OpenAI SDK, `@openai/agents`, `@openai/guardrails`                                                                   |
| Config             | `env-var` in `src/environment.ts`; local dev: `.env.local` via `@dotenvx/dotenvx` (`pnpm dev`, `migrate:latest:dev`) |
| Tests              | Vitest, `**/*.test.ts`                                                                                               |

**Package manager:** `pnpm` (see `package.json` `packageManager`).

## Layout

- `src/bot.ts` — bootstrap, `InteractionCreate` → registry, ready hook (`initFlashChat`), misc listeners.
- `src/botConfig.ts` — hardcoded-ish bot tuning (e.g. monitored channel IDs); token from env.
- `src/discordClient.ts` — single `Client` (Guilds, Messages, **MessageContent**, VoiceStates, GuildMembers).
- `src/features-system/commands/` — registry, Discord API registration, shared interaction typing.
- `src/features-system/commands-audit/` — command audit logging + schema/repo.
- `src/features-system/data-persistence/` — `database.ts` (Kysely `Database` interface aggregates feature tables), custom Kysely plugins, `migrate.ts` + `migrations/*.ts` (**custom `FileMigrationProvider` for Windows** — keep when touching migrations).
- `src/features/<name>/` — product features (see **Feature folder conventions** below).
- `src/shared/` — cross-cutting types/utilities (`resultPattern`, etc.).
- `src/utils/`, `src/healthcheck/` — helpers and heartbeat.
- `github-plan-cli/` — GitHub “Jarvis” plan + implement automation (`pnpm github-plan`, workflows `jarvis-plan.yml` / `jarvis-implement.yml`). **Local** implement: Cursor agent + `implementer-generic.md` → `pr-draft.json`. **CI** (`GITHUB_ACTIONS` is the string `true`): Node orchestrates Cursor agents via prompts in `github-plan-cli/prompts/` (no separate CI implementer under `.cursor/agents/`); structured reports under gitignored `.jarvis/ci/` (`implement-report.json`, `review-aggregate.json`, `review-feedback.md`); schemas and helpers in `github-plan-cli/src/plan/ciImplementArtifacts.ts`. Tests under `github-plan-cli/__tests__/`.

**Features (code):** `ai-reply`, `birthday-tracker`, `flash-chat`, `tickets`. **`voice-chat-engager`** is placeholder (`readme.md` only).

## Feature folder conventions

Each feature lives under `src/features/<kebab-name>/`. Expect this shape; add subfolders only when the feature needs them (avoid empty stubs).

| Piece                             | Role                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`init<Feature>.ts`**            | Wiring only: `interactionsRegistry.register(...)`, `DISCORD_CLIENT.on(...)`, or async startup. Import and invoke from `bot.ts` (sync init) or from `ClientReady` / other lifecycle hooks when the feature must wait until the client is ready. |
| **`index.ts`**                    | Barrel re-exports for what other packages import (commands, init, services, types). Depth varies by feature—mirror siblings when adding a new one.                                                                                             |
| **`commands/`**                   | Slash command `SlashCommandBuilder` + handler pairs; may split “deploy / admin” vs “user” commands across files (`deployTicketCommand.ts` vs `ticketCommands.ts`).                                                                             |
| **`components/`**                 | Message components and modals: builder + handler, often as factories (e.g. `FooComponent(enabled).component` / `.handler`) registered in `init*`. Re-export from `components/index.ts` when the folder exists.                                 |
| **`data/`**                       | **`<feature>Schema.ts`** — Kysely table interfaces (and Zod where used); **`<feature>Repo.ts`** — queries/mutations. Register tables on `Database` in `data-persistence/database.ts` + new migration.                                          |
| **`logic/`**                      | Domain rules that are not Discord handlers and not raw SQL (permissions, channel naming, state). Used heavily by `tickets`.                                                                                                                    |
| **`utils/`**                      | Feature-local helpers (validation, formatting, Discord-specific glue).                                                                                                                                                                         |
| **`constants.ts`**                | IDs, labels, static config for the feature (see `tickets`).                                                                                                                                                                                    |
| **`*Service.ts` / `*Manager.ts`** | Optional coordinators (lifecycle, per-guild workers) kept at feature root when not just DB I/O (`flash-chat`).                                                                                                                                 |
| **`readme.md`**                   | Optional feature-level notes for humans/agents.                                                                                                                                                                                                |

**Patterns:** Slash commands that ship globally are sometimes registered in `bot.ts` alongside `init*()` for the same feature (`flash-chat`, ticket deploy). Everything else that uses the registry usually lives in `init<Feature>.ts`.

**`flash-chat` extras:** `flashChatManager` / `flashChatService`, `configComponents/` for setup UI, `initFlashChat` runs after ready (not at module load).

**`ai-reply` layout:** Listener-based (no slash registry). Subfolders by concern: `agents/` (OpenAI agent graph), `antiAbuse/`, `lib/` (e.g. guardrails); flat files for orchestration (`aiReplyHandler.ts`, `newAiReplyStuff.ts`, `aiService.ts`, `messageUtils.ts`).

**New DB table:** add table type to `src/features-system/data-persistence/database.ts`, feature schema file, migration under `migrations/`, run `pnpm migrate:latest` (or `:dev`).

## Env (required unless noted)

`DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, `DB_TYPE` (`sqlite` \| `postgres`), `OPENAI_API_KEY`; plus `SQLITE_DB_PATH` or `PG_CONNECTION_STRING` per `DB_TYPE`. Optional: `ENV`, `AI_MODEL`, `AI_MAX_CONTEXT_MESSAGES`.

## Commands

- `pnpm dev` — watch `src/bot.ts` with env from `.env.local`.
- `pnpm build` / `pnpm start` — `tsc` → `dist/`, run `node dist/bot.js`.
- `pnpm migrate:latest` / `migrate:latest:dev` — DB migrations.
- `pnpm github-plan` — CLI for the Jarvis issue/PR plan workflow (see `github-plan-cli/src/cli.ts`).

## Conventions for edits

- Strict TypeScript; avoid `any` (see `.github/copilot-instructions.md`).
- Register new slash/modal/component: `interactionsRegistry.register(builder, handler)` and ensure slash builders included in `registerCommandsWithDiscord` path (via `getSlashCommandBuilders()`).
- Match existing patterns in the target feature folder (naming, Result usage, repo/schema split).
