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
- `src/features-system/activity/` — records every eligible guild message and reaction in `activity_events` (who, which channel — plus the parent channel for a thread — when; no content) from its own `MessageCreate`/`MessageReactionAdd` listeners, regardless of which features are enabled. Consumers register through `registerActivitySubscriber` (leveling awards XP this way) or read `activityEventsRepo.findLastMessageAt` (the flow scheduler, to push back a timed park's deadline while people are still talking); activity imports no feature. Each process is a row in `activity_recorder_sessions` (60s heartbeat); at `ClientReady` activity backfills, in the background and one request at a time, the messages Discord history holds for every gap since the last session (capped at 30 days, crash-safe, deduplicated on `activity_events.message_id`). Backfill is **record only** — no subscriber is notified — and while it runs `isBackfillPending()` makes the scheduler hold due runs that have a quiet window.
- `src/features-system/commands/` — registry, Discord API registration, shared interaction typing.
- `src/features-system/commands-audit/` — command audit logging + schema/repo.
- `src/features-system/data-persistence/` — `database.ts` (Kysely `Database` interface aggregates feature tables), custom Kysely plugins, `migrate.ts` + `migrations/*.ts` (**custom `FileMigrationProvider` for Windows** — keep when touching migrations).
- `src/features/<name>/` — product features (see **Feature folder conventions** below).
- `src/shared/` — cross-cutting types/utilities (`resultPattern`, etc.).
- `src/utils/`, `src/healthcheck/` — helpers and heartbeat.
- `generated/openapi.generated.json` — the dashboard API's OpenAPI spec, emitted from the real `/api` mount (`src/web/api/openApiDocument.ts`) and committed. Only routers built with `apiRouter()` (`src/web/api/openApi.ts`) appear in it.
- `packages/web-sdk/` (`@brattybot/web-sdk`) — the dashboard's API client, generated from that spec by `@hey-api/openapi-ts`: types, fetch functions, TanStack Query helpers, zod request schemas. `src/gen/` is generated **and committed**; `setupClient.ts` and `apiError.ts` are hand-written. Consumed as source (no build step).
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

**New flow block:** create one directory under `src/features/flows/blocks/` and nothing else — the registry discovers it and the builder draws it from what it declares. Then run `pnpm sdk:generate`: the builder checks a block's config fields against rules generated from its `configSchema` into the SDK (`FlowBlockFieldRules`, `src/features/flows/logic/blockFieldRules.ts`), and the drift tests fail until they are. Read `docs/contracts/block-authoring.md` first; it is the contract, not a tutorial.

## Env (required unless noted)

`DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, `DB_TYPE` (`sqlite` \| `postgres`), `OPENROUTER_API_KEY` (reply generation), `OPENAI_API_KEY` (guardrails only); plus `SQLITE_DB_PATH` or `PG_CONNECTION_STRING` per `DB_TYPE`. Optional: `ENV`, `OPENROUTER_BASE_URL`, `AI_MODEL` (OpenRouter slug), `AI_MAX_CONTEXT_MESSAGES`.

## Commands

- `pnpm dev` — `sdk:generate`, apply pending migrations, then watch `src/bot.ts` with env from `.env.local`. (`pnpm dev:bot` skips both.) A route edited while `tsx watch` runs is not regenerated until `pnpm sdk:generate`, a restart, or the next build — the drift tests catch a missed one.
- `pnpm build` — `sdk:generate`, then `tsc --noEmit`. A typecheck convenience that currently reports pre-existing errors unrelated to any one change. No test workflow runs it, but the Jarvis implement runner does (Node 22), and it commits the spec and SDK that `build` rewrites. Needs Node ≥ 22.18 for the generation step. Docker never runs it: the image (Node 20) runs `pnpm build:web` and the committed spec and SDK.
- `pnpm start` — run the bot from source with `tsx`. `src/scripts/dockerEntrypoint.sh` is the real container entrypoint: it applies migrations first, then `exec pnpm start`. Block discovery scans `src/features/flows/blocks/` for `index.ts` files, so the source tree is the one that runs — which is why `tsx` is a runtime dependency.
- `pnpm migrate:latest` / `migrate:latest:dev` — DB migrations.
- `pnpm github-plan` — CLI for the Jarvis issue/PR plan workflow (see `github-plan-cli/src/cli.ts`).
- `pnpm sdk:generate` — re-emit the OpenAPI spec and regenerate `packages/web-sdk/src/gen` from it. `build` and `dev` run it; run it yourself after changing a route mid-session. `openApiSpec.test.ts` (spec vs routes) and `generatedSdkIsCurrent.test.ts` (SDK vs spec) fail until you do. (`pnpm openapi:emit` writes the spec alone — not enough on its own.) Needs Node ≥ 22.18.
- `pnpm sdk:check` — `sdk:generate`, then fail if the spec or the SDK differs from what is committed (untracked files included).

## Conventions for edits

- Strict TypeScript; avoid `any` (see `.github/copilot-instructions.md`).
- Register new slash/modal/component: `interactionsRegistry.register(builder, handler)` and ensure slash builders included in `registerCommandsWithDiscord` path (via `getSlashCommandBuilders()`).
- Match existing patterns in the target feature folder (naming, Result usage, repo/schema split).
- Dashboard API routes: the only way to add one is `apiRouter((router) => { router.openapi(route, handler); })` (`src/web/api/openApi.ts`, see `guildRoutes.ts`) — the callback's surface has no `get`/`post`/…, refuses `hide: true` and an `async` callback, and `apiRouter.test-d.ts` holds those guards in `pnpm test` (Vitest typecheck mode). Define each with `createRoute`, an explicit `operationId`, named components (`.openapi('Name')` on request and response schemas), and the shared error maps from `openApi.ts`. `everyRouteInSpec.test.ts` fails on any route served under `/api` that the spec lacks; its `NOT_YET_IN_SPEC` list is a migration bridge for the routes not yet converted — it only shrinks (`NOT_YET_IN_SPEC_CEILING` fails the suite if it grows; lower the ceiling as routes convert), and a new route never goes on it. A new route beside unconverted ones gets its own `apiRouter`, mounted at the same prefix (as `guildRoutes` and `flowRoutes` share `/api/guilds`). `pnpm build`/`pnpm dev` regenerate the spec and SDK. A request schema states only what the server enforces — the browser checks forms against the generated zod. A request rule's fixed sentence travels with it: `buildOpenApiDocument` writes it into the spec as `x-messages` (`requestMessages.ts`) and the SDK's zod resolvers (`packages/web-sdk/zodMessageResolvers.ts`) pass it as the rule's message, so the browser shows the server's words. The emit fails, naming route and field, on any request rule the browser cannot be given faithfully — a dynamic message, a `.refine()`, a regex with flags, among others; the error says which and why. The same walk covers the one component registered without a route, `FlowBlockFieldRules` (`flowBlockFieldRules.ts`): the Flow Builder's field rules for every block, which the builder looks up by `node.type` in the generated `zFlowBlockFieldRules`. Wire schemas live in `src/web/api/*Body.ts` and are built with `@hono/zod-openapi`'s `z`: `.openapi()` exists only on a schema created after that package loaded, so a `src/features/**` schema (plain zod, loaded first in the bot) is rebuilt from its `.shape` before naming (`FlowGraphSchema` in `flowBody.ts`), never named in place. Type a body builder by `z.infer` of its schema, or hold a domain type sent as-is to its schema with `SchemaMatches` (`openApi.ts`); use `.readonly()` on arrays a domain type hands over unchanged, `z.union([X, z.null()])` rather than `.nullable()` on a named schema (the null would be copied into the component), and give an `.extend()`ed schema its own description (it inherits its parent's).
- Dashboard pages move to `@brattybot/web-sdk` (`useQuery(xOptions(...))` / `useMutation(xMutation())`) one at a time. The hand-written client and types in `web/src/api/` stay until their last caller moves; both clients throw the same `ApiError`. The root `tsconfig.json` resolves `@brattybot/web-sdk` to `packages/web-sdk/src/contract.ts` — the generated types and zod, no client (the root has no DOM library) — so a dashboard module that root tests import may use the SDK's types and zod, and fails the root type-check if it reaches for a query helper or `ApiError`. At run time a module under `web/` resolves the package from `web/node_modules` as usual, but nothing under `src/` can: a root file imports the SDK with `import type` only, and takes a value by relative path into `packages/web-sdk/src/gen/` (as `blockFieldRules.test.ts` does).
