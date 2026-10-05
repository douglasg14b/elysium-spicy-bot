# Agent brief — discord-spicy-bot

Discord bot (discord.js v14, ESM TypeScript). Entry: `src/bot.ts` → `DISCORD_CLIENT.login`; slash/components/modals route through `InteractionsRegistry` (`src/features-system/commands/interactionsRegistry.ts`). Feature modules call `init*()` to register handlers and side effects; some commands also registered in `bot.ts`.

## Product context

The bot is aimed at an **adults-only** Discord: **kinky**, **sex-positive**, **NSFW-appropriate** content, **dark humor**, and a **sassy** persona are intentional. Agents and code review must **not** push user-facing copy toward generic, child-safe, or corporate-friendly defaults. See `.cursor/rules/product-persona-and-audience.mdc`.

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
- `src/features-system/activity/` — records every eligible guild message and reaction in `activity_events` (who, which channel — plus the parent channel for a thread — when; no content) from its own `MessageCreate`/`MessageReactionAdd` listeners, regardless of which features are enabled. Consumers register through `registerActivitySubscriber` — a list, notified in parallel with each failure isolated (leveling awards XP this way; flows registers one subscriber — see `src/features/flows/` below) — or read `activityEventsRepo.findLastMessageAt` (the flow scheduler, to push back a timed park's deadline while people are still talking) and `findLastMessageBetween` (the outage catch-up); activity imports no feature. Each process is a row in `activity_recorder_sessions` (60s heartbeat); at `ClientReady` activity backfills, in the background and one request at a time, the messages Discord history holds for every gap since the last session (capped at 30 days, crash-safe, deduplicated on `activity_events.message_id`). Backfill is **record only** — no subscriber is notified — and while it runs `isBackfillPending()` makes the scheduler hold due runs that have a quiet window. Message waits are held longer: once it ends (`whenBackfillFinished`, which also fires when it failed), the scheduler looks for each parked message wait's reply in the restored history, one run at a time, before letting any of them time out.
- `src/features-system/commands/` — registry, Discord API registration, shared interaction typing.
- `src/features-system/commands-audit/` — command audit logging + schema/repo.
- `src/features-system/data-persistence/` — `database.ts` (Kysely `Database` interface aggregates feature tables), custom Kysely plugins, `migrate.ts` + `migrations/*.ts` (**custom `FileMigrationProvider` for Windows** — keep when touching migrations).
- `src/features/<name>/` — product features (see **Feature folder conventions** below).
- `src/features/flows/` message path — one activity subscriber, `engine/messageTriggerDispatch.ts` (`handleMessage`), first wakes runs parked on a message wait from an in-memory index (`engine/messageWaitIndex.ts`), then starts Message Sent runs from an in-memory per-guild trigger index (`engine/messageTriggerIndex.ts`, loaded on a guild's first message, dropped by a `FlowsRepo.registerAfterWrite` callback after every committed flow write). Both draw from the flood limit in `engine/messageActivityLimit.ts`; every event-started run (not buttons) begins through `startTriggeredRun` in `engine/triggeredRun.ts`.
- `src/features/flows/` ticket path — the ticket service (`src/features/tickets/ticketService.ts`, flows-free) announces every committed change — opened (on the first `recordTicketStateMessage`, once the ticket has its channel and its state embed — not `openTicket` or `attachTicketChannel`, both silent; a ticket whose embed never lands fires nothing), claimed, unclaimed, closed, reopened, deleted — to the subscriber list in `tickets/ticketChanges.ts` (`registerTicketSubscriber`), after a conditional write and never inside a transaction. Each change requires a `change` (`actorId`, `chainDepth`) its caller supplies: buttons and dashboard routes pass the person at depth 0, flow blocks pass the bot's own user id and their run's `context.chainDepth` (`actorId` is never null, so a Ticket Event run always has an actor — one who has left arrives as a partial member). Flows registers one subscriber, `logic/ticketEventDispatch.ts` (in `logic/`, not `engine/`, because `ticket` is a word the engine vocabulary gate rejects), which only `setImmediate`s its dispatch so a flow's own ticket change never runs another flow inside its step. Runs it starts are one deeper than the change; past `FLOW_MAX_CHAIN_DEPTH` (5) a start is refused and logged. Depth rides the run snapshot across parks. Only a ticket change carries depth: Kick Member → Member Leaves restarts at the root (`FLOW_ROOT_CHAIN_DEPTH`). Award XP never sets off Level Reached at all (`awardFlowXp` skips level-up subscribers).
- `src/features/flows/` runs about nobody — a trigger whose `requires` leaves out `subject` starts runs with no member (`FlowRunSeed.subject` absent, no `userId` in the snapshot; absent never means "left"). What a node needs is its block's `requires` plus its picked options' and its copy tokens' (`engine/nodeRequirements.ts`), checked at save and again by the executor before `run`; blocks read the member through `requireSubject`. No shipped trigger does this yet — step 3's Schedule trigger will.
- `src/shared/` — cross-cutting types/utilities (`resultPattern`, etc.).
- `src/utils/`, `src/healthcheck/` — helpers and heartbeat.
- `github-plan-cli/` — GitHub “Jarvis” plan + implement automation (`pnpm github-plan`, workflows `jarvis-plan.yml` / `jarvis-implement.yml`). **Local** implement: Cursor agent + `implementer-generic.md` → `pr-draft.json`. **CI** (`GITHUB_ACTIONS` is the string `true`): Node orchestrates Cursor agents via prompts in `github-plan-cli/prompts/` (no separate CI implementer under `.cursor/agents/`); structured reports under gitignored `.jarvis/ci/` (`implement-report.json`, `review-aggregate.json`, `review-feedback.md`); schemas and helpers in `github-plan-cli/src/plan/ciImplementArtifacts.ts`. Tests under `github-plan-cli/__tests__/`.

**Features (code):** `ai-reply`, `birthday-tracker`, `flash-chat`, `tickets`. **`voice-chat-engager`** is placeholder (`readme.md` only).

## Feature folder conventions

Each feature lives under `src/features/<kebab-name>/`. Expect this shape; add subfolders only when the feature needs them (avoid empty stubs).

| Piece                             | Role                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`init<Feature>.ts`**            | Wiring only: `interactionsRegistry.register(...)`, `DISCORD_CLIENT.on(...)`, or async startup. Import and invoke from `bot.ts` or from `ClientReady` / other lifecycle hooks when the feature must wait until the client is ready. Most are synchronous; `initFlows()` is `async` and **must be awaited before the web server starts**, because it discovers the block registry that the builder API reads. |
| **`index.ts`**                    | Barrel re-exports for what other packages import (commands, init, services, types). Depth varies by feature—mirror siblings when adding a new one.                                                                                             |
| **`commands/`**                   | Slash command `SlashCommandBuilder` + handler pairs; may split “deploy / admin” vs “user” commands across files (`deployTicketCommand.ts` vs `ticketCommands.ts`).                                                                             |
| **`components/`**                 | Message components and modals: builder + handler, often as factories (e.g. `FooComponent(enabled).component` / `.handler`) registered in `init*`. Re-export from `components/index.ts` when the folder exists.                                 |
| **`data/`**                       | **`<feature>Schema.ts`** — Kysely table interfaces (and Zod where used); **`<feature>Repo.ts`** — queries/mutations. Register tables on `Database` in `data-persistence/database.ts` + new migration.                                          |
| **`logic/`**                      | Domain rules that are not Discord handlers and not raw SQL (permissions, channel naming, state). Used heavily by `tickets`.                                                                                                                    |
| **`utils/`**                      | Feature-local helpers (validation, formatting, Discord-specific glue).                                                                                                                                                                         |
| **`templates/`**                  | Seed data the feature ships: a factory returning a ready-made record plus the script that installs it, kept together so the copy and its installer cannot drift (`flows/templates/onboardingFlow.ts` + `seedOnboardingFlow.ts`).                |
| **`constants.ts`**                | IDs, labels, static config for the feature. Only when there is genuinely something static: `tickets` had one holding a channel-name template nothing rendered from, and deleting the template deleted the file. Seed data an operator can later edit belongs in `data/` beside the schema that owns its type (`tickets/data/defaultTicketTypes.ts`). |
| **`*Service.ts` / `*Manager.ts`** | Optional coordinators (lifecycle, per-guild workers) kept at feature root when not just DB I/O (`flash-chat`).                                                                                                                                 |
| **`readme.md`**                   | Optional feature-level notes for humans/agents.                                                                                                                                                                                                |

**Patterns:** Slash commands that ship globally are sometimes registered in `bot.ts` alongside `init*()` for the same feature (`flash-chat`, ticket deploy). Everything else that uses the registry usually lives in `init<Feature>.ts`.

**`flash-chat` extras:** `flashChatManager` / `flashChatService`, `configComponents/` for setup UI, `initFlashChat` runs after ready (not at module load).

**`ai-reply` layout:** Listener-based (no slash registry). Subfolders by concern: `agents/` (OpenAI agent graph), `antiAbuse/`, `lib/` (e.g. guardrails); flat files for orchestration (`aiReplyHandler.ts`, `newAiReplyStuff.ts`, `aiService.ts`, `messageUtils.ts`).

**New DB table:** add table type to `src/features-system/data-persistence/database.ts`, feature schema file, migration under `migrations/`, run `pnpm migrate:latest` (or `:dev`).

**New flow block:** create one directory under `src/features/flows/blocks/` and nothing else — the registry discovers it and the builder draws it from what it declares. Read `docs/contracts/block-authoring.md` first; it is the contract, not a tutorial. A field naming a ticket type uses the `ticketTypePicker` control, which offers the guild's own types — never hardcode the seeded `support`/`verification`.

## Env (required unless noted)

`DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, `DB_TYPE` (`sqlite` \| `postgres`), `OPENROUTER_API_KEY` (reply generation), `OPENAI_API_KEY` (guardrails only); plus `SQLITE_DB_PATH` or `PG_CONNECTION_STRING` per `DB_TYPE`. Optional: `ENV`, `OPENROUTER_BASE_URL`, `AI_MODEL` (OpenRouter slug), `AI_MAX_CONTEXT_MESSAGES`.

## Commands

- `pnpm dev` — apply pending migrations, then watch `src/bot.ts` with env from `.env.local`. (`pnpm dev:bot` skips the migration step.)
- `pnpm build` — `tsc` → `dist/`. A local typecheck convenience, not wired into CI, and it currently reports pre-existing errors unrelated to any one change. Nothing runs the compiled output.
- `pnpm start` — run the bot from source with `tsx`. `src/scripts/dockerEntrypoint.sh` is the real container entrypoint: it applies migrations first, then `exec pnpm start`. Block discovery scans `src/features/flows/blocks/` for `index.ts` files, so the source tree is the one that runs — which is why `tsx` is a runtime dependency.
- `pnpm migrate:latest` / `migrate:latest:dev` — DB migrations.
- `pnpm github-plan` — CLI for the Jarvis issue/PR plan workflow (see `github-plan-cli/src/cli.ts`).

## Conventions for edits

- Strict TypeScript; avoid `any` (see `.github/copilot-instructions.md`).
- Register new slash/modal/component: `interactionsRegistry.register(builder, handler)` and ensure slash builders included in `registerCommandsWithDiscord` path (via `getSlashCommandBuilders()`).
- Match existing patterns in the target feature folder (naming, Result usage, repo/schema split).
