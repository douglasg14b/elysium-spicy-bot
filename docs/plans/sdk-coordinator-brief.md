# SDK migration: brief for each step's implementer

You are one step in a sequence the coordinator runs. Douglas is the user. He asked the coordinator to have one subagent per step do the bulk work. Read this brief completely before you start.

## Where you work

- **Worktree:** `C:\Users\Douglas\Documents\01 Programming\01 Personal\discord-spicy-bot-web-sdk`
- **Branch:** `feat/web-sdk`
- Work **only** there. Never touch the main checkout at `...\discord-spicy-bot`, which is on another branch with other sessions working in it.
- **Never open `.env*` files.** They hold secrets.
- **Do not commit or push.** The coordinator commits after reading your report.
- Use the dedicated Read, Edit and Write tools for file changes, not shell redirection, sed or scripts.
- Add dependencies only with `pnpm add`. Never hand-edit versions in `package.json`.
- Follow `.claude/rules/*.md`, all of them:
  - strict TypeScript, no `any`, no single-letter names;
  - JSDoc on public functions;
  - tests in `__tests__` beside the code;
  - exhaustive switches;
  - root cause over workarounds;
  - no gold plating.
- **The bot's persona is adults-only, sassy and NSFW-appropriate on purpose.** Keep existing user-facing copy and its voice. Never sanitize it. When copy has to change, write it in the same voice.

## Read first

- `AGENTS.md`, especially "Commands" and "Conventions for edits". The dashboard API route and page bullets are the contract.
- `docs/plans/sdk-1-walking-skeleton.md` through `sdk-4-ticket-settings.md`. Read at least their "As built", traps and follow-ups sections, because they record what bit earlier steps.
- Models to copy:
  - **Route model:** `src/web/api/flowRoutes.ts`, `flowBody.ts`, `ticketRoutes.ts`, `ticketBody.ts`, `openApi.ts`.
  - **Page model:** `web/src/pages/TicketsConfigPage.tsx`, `ServerSettingsPage.tsx`, `FlowsListPage.tsx`. They show the keyed inner form, `useQuery(xOptions({ path }))`, `useMutation(xMutation())`, `cancelQueries`/`setQueryData`, and `createDashboardQueryClient()`.
  - **Form rules model:** `web/src/api/fieldProblems.ts`, where the generated zod's `safeParse` gives the server's sentences per field.

## What the pipeline guarantees (don't break it, build on it)

- **Every `/api` route is in the spec, or on the shrinking `NOT_YET_IN_SPEC` bridge list.**
  - The gate is `src/web/api/__tests__/everyRouteInSpec.test.ts`.
  - Lower `NOT_YET_IN_SPEC_CEILING` as you convert routes. Never raise it.
- **Drift gates fail when the spec or SDK is stale:**
  - `openApiSpec.test.ts`: the spec against the routes.
  - `packages/web-sdk/__tests__/generatedSdkIsCurrent.test.ts`: the SDK against the spec.
  - Run `pnpm sdk:generate` after changing routes. Run it twice, and the output must be identical.
- **Request-rule sentences travel to the browser.**
  - `src/web/api/requestMessages.ts` writes `x-messages`, and `packages/web-sdk/zodMessageResolvers.ts` puts them into `zod.gen.ts`.
  - The emit fails loudly on any rule whose sentence can't travel faithfully. Don't weaken those failures to get past them; restructure the schema instead, or stop and report.
- **Type guards live in `*.test-d.ts`,** which `pnpm test` checks in Vitest typecheck mode. Root `tsc` is red with pre-existing errors and is not in CI.

## Douglas's standing decisions

- **Rules come from the server, never from a browser copy.** When a step makes a hand copy dead, delete it. Don't keep it alongside.
- **The browser shows the server's own sentence, delivered at build time.** It is never reworded in the browser and never fetched at runtime. A sentence that names the bad value can't travel, so it becomes fixed text. Douglas accepted that trade.
- **The browser may under-report problems but must never flag something the server accepts.**
  - A rule that needs the server (a renderer, the database, Discord state) stays server-only, and the browser learns it from the refusal.
  - A "browser never refuses what the server accepts" parity test is the standard guard wherever a pattern is involved.
- **Plan one step at a time.**
  - Write your step's plan to `docs/plans/sdk-<n>-<slug>.md`, in the shape of the earlier plans.
  - Then build it.
  - Then add an "As built" section with Checks and Follow-ups.
- **Stop for genuine product decisions.** If a choice is genuinely Douglas's to make (a user-visible behaviour change that isn't mechanical, rewording copy beyond what a rule forces, dropping a feature), don't guess. Finish what doesn't depend on it, or stop after the plan, and put the question in your report in plain terms: one sentence per option, plus your recommendation. Conventional engineering choices are yours; make them and record them in the plan.

## Traps already paid for

- **`.openapi()` doesn't exist on a zod schema built before `@hono/zod-openapi` loads.** A `src/features/**` schema is plain zod, so rebuild it from `.shape` with the library's `z` in `src/web/api/*Body.ts`. Never name it in place, and never import hono or zod-openapi into `src/features/**`.
- **Status maps (`GUILD_SCOPED_ERRORS` etc.) are deliberately not `as const`.** One schema per status; `z.union([X, z.null()])` rather than `.nullable()` on named schemas.
- **zod-to-openapi drops the name of a nullable union.**
- **Converting a route to `apiRouter` changes behaviour:**
  - a body sent without a JSON content type gets 415;
  - malformed JSON gets `Malformed JSON in request body`;
  - path and query are validated before the body.

  Record each change in the plan and pin it with tests.
- **Route tests that `vi.mock` a module without `importOriginal` break when that module gains exports the routes now import.**
- **The SDK serializes query strings in its own order.** Tests asserting an exact query string must compare parsed params instead.
- **Subagents and reviewers have injected sabotage into real files before.** After every subagent you spawn, check `git status` and grep for markers (`SABOTAGE`, `XXX`, `TEMP`).
- **Spawn review specialists directly.** The `reviewer` orchestrator degrades silently when its own Task calls fail.
- **Never disable an input someone is typing into.** A `disabled={saving}` on a field that saves as you type steals its focus.
- **Line endings.** This machine has `core.autocrlf=true`, and the generator writes LF. After generating, `git status` shows ~18 `packages/web-sdk/src/gen/*` files as modified with an empty `git diff`. That is noise; don't chase it. `sdk:check` reports it too.
- **Baselines** (measure quietly; suites with a 20 s timeout flake under parallel load, so rerun a failing file alone before calling it real):
  - `pnpm test`: 3,039 pass, 1 known failure (`ciBranchProductDiff`). The birthday test "skips overlapping runs" is a known date-dependent flake.
  - Root `tsc --noEmit`: the same 17 pre-existing errors, none new.
  - `pnpm typecheck:e2e`: the same 4.
  - Web `tsc -b` and `pnpm --filter @brattybot/web-sdk typecheck`: clean.

## Verification is the job, not a formality

- **Every new guard is sabotage-verified.** Break the thing it guards, watch a named test fail, then restore it, re-run `pnpm sdk:generate` and confirm the output is byte-identical. Report each one.
- **Run the real end-to-end path where one exists:** `web/e2e/*.test.tsx`, driven against TestDiscord. Read `web/e2e/support/` before you write e2e.
- **One review pass,** after your own verification. Spawn `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` yourself, in the foreground, scoped to your step's files. Exclude `generated/**` and `packages/web-sdk/src/gen/**`, and tell them not to modify files.
  - Fix Critical and High findings.
  - Fix Mediums where cheap and in scope.
  - List the rest in the plan's Follow-ups.
  - Check `git status` after the reviewers return.

## Your report to the coordinator

- Files changed, grouped by area.
- Design choices beyond the plan.
- Behaviour changes, with exact new sentences.
- Check numbers against the baselines above.
- Sabotage results.
- Review findings: fixed, and left.
- Questions for Douglas, if any.
- `git status --short`, without the line-ending-only gen files.

Be honest about anything not run or not verified.
