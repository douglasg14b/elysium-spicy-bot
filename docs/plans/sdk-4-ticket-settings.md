# SDK step 4: ticket settings, and the first field rules the browser gets from the server

Follows steps 1–3 (`sdk-1-walking-skeleton.md`, `sdk-2-spec-cannot-be-skipped.md`, `sdk-3-flow-routes.md`; `f9653d2` pushed). Douglas picked ticket settings on 2026-10-03, ahead of the Flow Builder.

## Why this slice

Steps 1–3 built the pipeline but did not meet the original goal. `zod.gen.ts` is generated, but only `WarningsPage` uses it, and only for pass/fail. The browser's real hand copy of server rules is `web/src/tickets/ticketTypeForm.ts`. Its own comment calls it "a mirror, so it will drift", and its length check is **stricter than the server's** (it neither sanitizes nor collapses `--`), so it can refuse a template the server accepts.

Converting the ticket routes as they stand would carry only "label not empty" and "template not empty". The key rule and the template rules are hand code in `upsertTicketType`, not declared rules. This step therefore does three things:
- turns those rules into declared rules;
- makes the server's own sentences travel with them;
- deletes the browser copy.

## Decisions taken

- **The browser shows the server's own sentence, delivered at build time** (Douglas, 2026-10-03). It is not reworded in the browser, and it is not fetched at runtime.
- **Sentences that name the bad value cannot travel.** Douglas accepted this when choosing. Two server sentences become fixed text:
  - The key sentence loses its ``\`${type}\` will not do as a key —`` prefix.
  - The unknown-token and stray-brace sentences become one sentence about the token rule, because a single pattern now checks both.
- **Rules that need the real renderer stay server-only:** "renders to nothing" and "longest render over 100". The browser learns them from the refusal on Save. Under "the browser may under-report, never over-report", that is correct.

## Proven before planning (spikes, all reverted)

- **A `.regex()` on a body field or a path parameter comes out in `zod.gen.ts` as `.regex(...)`.** Path parameters land as a per-operation `z<Op>Path` object the form can use directly.
- **A zod 4 `error` function lets the server word a refusal while the exported rule stays a plain `pattern`.**
- **The sentence can ride inside the generated zod:**
  - `buildOpenApiDocument` attaches `x-messages` (keyword → sentence) to each request schema node's registry meta before generating, and zod-to-openapi emits it beside the keyword.
  - The hey-api zod plugin's `$resolvers` pass it as the message argument, as in `.min(1, 'Pick a channel. …')`.
  - In the browser, `safeParse` then returns the server's sentence as `issue.message`. There is no message map and no browser wording.
  - The spec with `x-messages` stripped is identical to today's.

## Scope

### 1. Build-time messages (the pipeline, before any ticket work)

**Emit side** (`src/web/api/openApiDocument.ts`, plus an extractor beside it):
- Walk every route in `openAPIRegistry.definitions`: its `params`, `query` and JSON `body`. Recurse through optional, nullable, default, pipe, object, array and union.
- For each check that carries a **fixed** message, merge `x-messages: { <keyword>: sentence }` into that node's meta. The keywords are:
  - `minLength`/`maxLength` for strings, `minItems`/`maxItems` for arrays;
  - `minimum`/`maximum`, and their exclusive forms;
  - `pattern`.
- **The emit fails loudly, naming the route and field, on any of these in a request schema:**
  - **A dynamic message,** meaning an `error` function that reads the issue. It cannot be written down at build time. Detected with a probe that records property reads.
  - **A `.refine()`,** a rule the browser cannot run. There are none in request schemas today. A future one has to be stated on purpose: move it into the handler, or into a named exception list in the extractor.
  - **A regex with flags.** zod-to-openapi emits `/^abc$/i` as `"^abc$/i"`, so the browser would refuse valid input.
- Checks without a custom message are left alone. The server's `defaultHook` sends zod's default sentence, and the browser's zod produces the same one.

**SDK side** (`packages/web-sdk/openapi-ts.config.ts`):
- Zod plugin `$resolvers` for `string`, `array` and `number` add the sentence as the message argument, then fall through to hey-api's own resolver.
- **Nullable fallback:** hey-api splits `type: [string, null]` and drops `x-` keys from the parts, so read the parent's `x-messages` there. No route needs it yet; ship it rather than the gap.
- Must pass `satisfies UserConfig` without an `any` cast.

**Guards:**
- A test asserts that one known server sentence appears in `zod.gen.ts` beside its rule. The stale-SDK test catches output drift but not a message silently dropped, for example by a hey-api upgrade that renames its resolver nodes.
- Extractor unit tests cover each keyword, nesting, union branches and path parameters, plus each of the three loud failures.
- Steps 1–3 already carry messages, so regenerating changes `zWarningsConfigUpdate`, `zFlowCreate`, `zFlowUpdate` and `zFlowDraftSave`.

### 2. Server: the 10 ticket routes on `apiRouter`

**Routes:** list, detail, the four lifecycle actions (still one loop, now over `router.openapi`), get config, put config, put type, delete type. Each gets an `operationId` named after today's client function: `listTickets`, `getTicket`, `claimTicket`/`unclaimTicket`/`closeTicket`/`reopenTicket`, `getTicketsConfig`, `updateTicketsConfig`, `saveTicketType`, `deleteTicketType`.

**Where the rules live, once:** a plain-zod `src/features/tickets/logic/ticketTypeRules.ts` (no hono, no `.openapi()`):
- `TicketTypeKeySchema`: `/^[a-z0-9_-]+$/` with the key sentence.
- `TicketNameTemplateSchema`: trim, min 1, and a pattern **built from `SUPPORTED_TOKENS`**, "only known `{{tokens}}`, no stray braces", with its fixed sentence.
- `TicketTypeLabelSchema`: trim, min 1.

The route composes these: `type` in the path, label and template in the body.

`upsertTicketType` stops repeating them. It keeps the render-based checks (empty render, longest render) and the state refusals. Its tests for key, label, token and brace move to `ticketTypeRules` tests, and the sentences stay asserted word for word.

**Wire shapes:** move from interfaces in `ticketRoutes.ts` to zod in `src/web/api/ticketBody.ts`, following the step 3 conventions:
- `z.infer` or `SchemaMatches`;
- `.readonly()` on pass-through arrays;
- one schema per status.

The list envelope `{ tickets, counts, truncated }` gets a named schema.

**Error statuses declared exactly as sent:**
- `REFUSAL_STATUS` and `SETTINGS_REFUSAL_STATUS`: 409, 404, 400, 503, 423, 502.
- The resolve-ticket 400 and 404.
- DELETE's 204, with no body.

**Bridge list:** `NOT_YET_IN_SPEC` loses 10 entries, and the ceiling drops from 38 to 28.

**Behaviour that changes** (all the same kinds step 3 recorded):
- A body that isn't JSON gets 415.
- Malformed JSON gets `Malformed JSON in request body`.
- A bad `type` key is refused by the path schema before the handler runs.
- A bad template gets the single fixed token sentence.

**Behaviour that must not change:** every other sentence, every status, and the `ticketTypeBody` stripping a stray `type` from the body. It stays non-strict, as today.

### 3. Web: `TicketsConfigPage` on the SDK

- **Loading and saving:** config, roles and channels load through `useQuery(…Options)`. Put config, put type and delete type use `useMutation`. The `useEffect` fetching goes.
- **What doesn't change:** the reload on 502/503 after a categories save, the 409 that keeps the delete dialog open, and the `syncWarning` handling.
- **Type modal:** fields check against the generated `zSaveTicketTypePath` and `zSaveTicketTypeBody`. A small helper, `fieldProblems(result)`, maps each field to the message of its first issue. It is shared, so the later block-fields step can reuse it.
  - The draft is checked trimmed, as it is sent. A "   " label passes the browser's zod because trim does not survive into the spec, so it is checked after trimming.
  - Save is disabled while the problems map is not empty.
- **Out of this step:** the list and detail pages keep their fetching. They switch only their **types** to the SDK's, so the hand types can go.

### 4. Retire what this makes dead

- In `ticketTypeForm.ts`: `validateTicketTypeDraft`, `isTicketTypeDraftValid`, `SUPPORTED_TEMPLATE_TOKENS`, `CHANNEL_NAME_MAX_LENGTH` and their tests. `emptyTicketTypeDraft` and `draftFromType` stay.
- The ticket section of `web/src/api/types.ts`, along with its 11 `*_KEYS` and the `TicketKeyListsAreComplete` gate.
- `src/web/api/__tests__/ticketWireShapeDrift.test.ts`, and the `*_KEYS` and `keyListsAreComplete` in `ticketRoutes.ts`.
- In `web/src/api/tickets.ts`, only the config functions go. The list, detail and action functions stay, re-typed from the SDK, until the list and detail step.
- `web/e2e/preview/scenario/seedTickets.ts` takes its types from the SDK.

## Checks

- **Full suite against the baseline:** 2,939 pass. The 2 known failures are the birthday "skips overlapping runs" and `ciBranchProductDiff`.
- **Typechecks:**
  - root `tsc`: the same 17 pre-existing errors;
  - `typecheck:e2e`: the same 4;
  - web `tsc -b` and the SDK typecheck: clean.
- **`pnpm sdk:generate` run twice gives identical output, and `sdk:check` is clean.**
- **Sabotage-verify each new guard:**
  - Change a sentence in a zod rule: the spec gate and the stale-SDK test fail.
  - Add a dynamic message: the emit fails, naming the field.
  - Add a regex flag: the emit fails.
  - Remove the resolvers: the known-sentence test fails.
  - Make the token pattern stricter than the server: a "browser never refuses what the server accepts" table over sample templates fails.
- **`web/e2e/ticketActions.test.tsx`** "declaring a ticket type from the config page" still passes. Add a case: a bad key shows the server's sentence under the field before Save.

## As built

### Section 1: build-time messages
- **Extractor:** `src/web/api/requestMessages.ts`, called from `buildOpenApiDocument`. It writes `x-messages` into each request schema node's registry meta.
- **Resolvers:** `packages/web-sdk/zodMessageResolvers.ts`, wired through `$resolvers` in `openapi-ts.config.ts`.
  - **Patterns** go through hey-api's own node via an in-memory `x-pattern-message`.
  - **Min/max/length** nodes are copies of hey-api's. A comparison test holds them to hey-api's output with the sentences stripped.
  - **Nullable parts** find their parent's sentences by object identity in the IR (a `WeakMap`), not by path.
- **The emit fails loudly**, naming the route and field, on any of these in a request schema:
  - a dynamic message;
  - a `.refine()` or `z.custom()` check;
  - a regex with flags (only `format === 'regex'`);
  - a fixed sentence with no keyword to travel beside (`.int('…')`, `z.email('…')`, `z.string('…')`, an array's `.length(n,'…')`);
  - two checks feeding one keyword, unless both carry the identical sentence. zod-to-openapi emits only one bound per keyword.
- **Not walked:** headers, cookies and non-JSON bodies. No route uses them.
- **Guards:**
  - every spec sentence appears in `zod.gen.ts` as many times as the spec holds it;
  - the server and SDK keyword vocabularies match;
  - `safeParse` in the browser returns the server's sentence.

### Sections 2–4: ticket settings
- **Rules:** `src/features/tickets/logic/ticketTypeRules.ts` owns the key, label and template rules, and `SUPPORTED_TOKENS`.
  - The route composes them.
  - `upsertTicketType` parses with the same schemas, so a future caller can't skip them. It keeps the render-based checks.
  - The key also keeps `min(1)` with the existing blank-key sentence.
- **Routes:** all 10 are on `apiRouter`. The bridge ceiling is now 28.
  - `TicketCategoryChoice` is not a named schema, because zod-to-openapi drops the name of a nullable union.
  - The list query's `status` stays a handler check, because its refusal names the value. `type ≤ 64` travels.
- **Web:**
  - `TicketsConfigPage` runs on `useQuery`/`useMutation`.
  - The type modal checks the trimmed draft (`ticketTypeRequest`) against `zSaveTicketTypePath` and `zSaveTicketTypeBody` through `web/src/api/fieldProblems.ts`.
  - A type save or delete no longer resets an unsaved categories draft.
- **Retired:** the browser rule copy in `ticketTypeForm.ts`, the ticket section of `types.ts` (11 `*_KEYS`), `ticketWireShapeDrift.test.ts`, and the config functions in `web/src/api/tickets.ts`.

### Behaviour changes
Beyond those listed in §2:
- **The path is checked before the body.** A bad key with a bad body gets the key sentence, and a bad key with a non-JSON body gets 400 rather than 415.
- **A repeated query key** (`?status=a&status=b`) is refused with zod's default sentence. It used to take the first value.
- **The template hint now reads:** "Only {{####}}, {{subject}} and {{opener}} render. Anything else won't save."

### Checks
- **Suite:** 3,039 pass, 1 known fail (`ciBranchProductDiff`).
- **Typechecks:** root `tsc` has the same 17 errors and `typecheck:e2e` the same 4; web and SDK are clean.
- **Generation:** identical across runs.
- **Sabotage** caught each of these:
  - a stricter token pattern, on the server and in `zod.gen.ts`;
  - a hidden route;
  - a changed sentence;
  - the field-error wiring removed;
  - `{{user}}` added to the tokens;
  - the `upsertTicketType` parse bypassed;
  - in section 1: dynamic messages, regex flags, disabled resolvers, the nullable fallback reverted, and a dropped occurrence.
- **Review:** one pass per section, with domain-runtime and maintainability reviewers run directly. No Critical or High findings; the Mediums are fixed.

### Follow-ups
- **Long keys:** a key over 64 characters saves but can't be used as a list filter. This predates this step and needs a key rule with its own sentence.
- **e2e log noise:** the runs log "Failed to update deployed ticket message: Expected token…" from the panel refresh. Not checked against the base branch.
- **`sdk:check` noise:** on this machine (autocrlf) it lists line-ending-only changes in `src/gen` after any generate.

## Deferred (each its own step, planned when reached)

- **Ticket list and detail pages onto the SDK.** `ticketActions.test.tsx:500` asserts an exact query-string order, so pin parsed params instead.
- **Flow Builder onto the SDK.**
- **Block field rules at build time:**
  - Per Douglas, the runtime `/api/nodes` `fieldChecks` path is replaced by this pipeline and then **deleted**.
  - The gates from `client-field-checks` carry over: evaluator parity, and "never flag what the server accepts".
  - `fieldProblems` and the message pipeline built here are its foundation.
- **The remaining 28 bridge routes.**
