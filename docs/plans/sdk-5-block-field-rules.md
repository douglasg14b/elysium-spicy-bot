# SDK step 5: Flow Builder field rules delivered at build time, and the runtime path deleted

Follows steps 1–4 (`sdk-1-walking-skeleton.md` … `sdk-4-ticket-settings.md`; `9947008` pushed).

> **Built, and partly superseded by its own "As built".** Where they differ, "As built" is the record:
> - Whole numbers travel to the browser, so they are not server-only (§2).
> - A field with no rule but its type is `unchecked` (§2).
> - The rules are handed to `liveFieldIssues` rather than imported, and are looked up with `Object.hasOwn` (§6).

## Why this slice

Douglas, 2026-10-03: "We shouldn't have to have a runtime check for this or a runtime path for this. If we create a build-time path for this, then the runtime path is now superseded by it and should be removed."

Today the builder checks a block's config fields as the author types from rules the server works out **per request**:
- `GET /api/nodes` serves `fieldChecks` on each descriptor (`DERIVED_MEMBERS` in `nodeRoutes.ts`), derived from each block's `configSchema` by `src/features/flows/logic/fieldChecks.ts`.
- The browser runs them through its own evaluator (`web/src/flows/fieldChecks.ts`), a hand copy of the server's, held to it by a parity test.
- The server rewords its own complaints with `fieldCheckIssueMessage`, by re-running that evaluator on the value.

Step 4 built the build-time path (`x-messages` → `zod.gen.ts` → `fieldProblems`). This step puts the block rules on it and deletes the runtime path: the descriptor member, both evaluators, the rule vocabulary mirrored across the workspace, and the drift row that held the mirrors together.

## Proven before planning (spikes, all reverted)

- **A component registered on its own reaches the SDK.** `app.openAPIRegistry.register('X', libraryZodObject)` with no route referring to it comes out in the spec under `components.schemas`, and hey-api generates `zX` and the type `X` for it. An object keyed by block type generates as `z.object({ 'action.sendDM': z.object({...}), ... })`, so the builder looks a block up by `node.type` in the generated map with no hand list.
- **The sentences ride along unchanged.** Walked by `attachRequestMessages`, `z.string().min(1, 'Fill this in.')` on that component carries `x-messages`, and the generated line is `z.string().min(1, 'Fill this in.')`. A block's own `.regex()` check, attached to a fresh library string with `.check(theBlocksCheck)`, carries the block's own sentence: `.regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'A name must start with a letter …')`.
- **The registry's definitions are routes only today**, so walking `type: 'schema'` definitions touches nothing that exists.
- **zod 4 issue shapes** for the server's wording: absence is `invalid_type` (an enum's is `invalid_value`); `.int()` is `invalid_type` with `expected: 'int'`; a limit is `too_small`/`too_big` with `origin` (`string`/`number`/`array`), the bound and `inclusive`.
- **Coercion is invisible in the JSON Schema export.** `level` (`trigger.levelReached`, `condition.levelAtLeast`) and `amount` (`action.awardXp`) are `z.coerce.number()` behind a `text` control, so they hold strings, while `z.toJSONSchema` calls them `type: integer`. A generated `z.number()` there would refuse `'5'`, which the server accepts. The old evaluator only escaped this because "a number rule passes a string".
- **Every control writes a value for a required field it edits:** text and pickers write `''`, a duration `0`, a list `[]`. Only `optional` fields' controls remove the key. So the browser never needs to judge absence.

## Decisions taken

### 1. One generated component, `FlowBlockFieldRules`, keyed by block type
- **What it is:** what the browser may check about each drawn field. It is **not** the config type: every field is optional, and anything the browser can't check faithfully is `unknown`. The component's description says so, so step 6 doesn't mistake `FlowBlockFieldRules['action.sendDM']` for what `node.data` holds.
- **Why a free component:** no route sends or receives it, and `/api/nodes` stays on the bridge. Converting `/api/nodes` (the 11-arm `BlockConfigField` union) is the Flow Builder's move onto the SDK, step 6. The component is the seam: the builder already reads it, whatever fetches the descriptors.
- **Name:** one name, `FlowBlockFieldRules`. The block types are property keys, so no block type becomes a TS identifier and nothing can collide.

### 2. What travels, and what stays server-only
Per drawn field, from the block's input JSON Schema export (as today) plus its zod for coercion and the regex check:

| Field's exported shape | Browser schema |
| --- | --- |
| `type: string` | `z.string()` with `minLength`, `maxLength` and `pattern` |
| `type: number` / `integer`, not coerced | `z.number()` with `minimum`, `maximum`, `exclusiveMinimum` and `exclusiveMaximum` |
| `type: array` | `z.array(z.unknown())` with `minItems` and `maxItems` |
| coerced, or no single type (`oneOf`, `{}`), object, boolean | `z.unknown()` |

Every field is `.optional()`.

**Server-only, and why the browser under-reports them safely:**
- **Absence.** Controls never remove a required key, and the server still says "Fill this in." on Save.
- **Whole numbers.** The duration control writes whole milliseconds. "Whole numbers only." stays the server's.
- **Coerced numbers.** The browser sees the raw string. These were effectively unchecked before.
- **`format`.** The URL rules are refined further than the format says, and they carry the block's own wording.
- **`enum`/`const`.** Selects only offer declared values.
- **`oneOf`/`anyOf`.** The eligibility control emits whole, valid shapes.
- **List entries** (`items`, nested `properties`/`required`/`additionalProperties`). These are addressed by dotted path.
- **`.refine()`/`.superRefine()`.** They aren't in the export at all.

Each of these is still heard about on blur, from the re-check.

**What starts being checked live:** `pattern`. The three pattern fields' sentences are the blocks' own fixed sentences, and they now travel. Those fields are a variable name in Pick Random, Set Variable and Time Since, and the embed colour. This is a behaviour change (see below). It is guarded by a "browser never refuses what the server accepts" table.

**An unclassified keyword fails the emit**, naming block, field and keyword. So do a drawn field missing from the export, a `pattern` with no matching `.regex()` check, and more than one `.regex()` on one field. The gate moves from a test into the derivation the emit runs, so `pnpm sdk:generate` (and `pnpm dev`) stops on it. A unit test proves each failure can happen.

### 3. One wording function, two callers
`fieldRuleSentence(rule)` in the features module is the only place a field rule is worded. Its sentences are exactly today's `withMessage`. The one refinement is that `minLength` 1 reads "Fill this in." on a required field and "Can't be empty." on an optional one. Before, a separate `required` check said "Fill this in." about `''`, and it came first, so the outcome is the same.
- **At emit:** each limit's sentence is attached as the check's fixed message, so the step-4 walk writes it as `x-messages`.
- **On the server, at runtime:** `fieldRuleIssueMessage(issue, node)` maps a zod issue to its rule:
  - absent → `required`;
  - `expected: 'int'` → `integer`;
  - `too_small`/`too_big` by `origin` and `inclusive` → the limit keyword, using **the issue's own bound**.

  It words the issue with the same function. It no longer re-evaluates the value, so the server evaluator goes.
- **Required-ness has one source** on both sides: the cached export's `required` list (`fieldJsonSchemas`).
- **Block authors still write no sentences.** A `.regex()` keeps the message it always had, and that message is now what the browser shows too.

### 4. The walk extends to registered components
`attachRequestMessages` also walks `type: 'schema'` definitions. A component registered on its own is there for the browser to check against, so it gets the request rules. That means every step-4 failure applies: a dynamic message, a refine, regex flags, a sentence with no keyword, and conflicting bounds. A failure names the component path (`components.schemas .action.pickRandom.outputKey: …`).

The browser schema is built from **fresh** library-zod nodes. Only the block's regex *check* instance is reused, never a block's schema node. The walk writes `x-messages` into `z.globalRegistry`, and `z.toJSONSchema` exports registry metadata, so writing onto a block's own node would leak `x-messages` into `fieldJsonSchemas` and trip the keyword gate.

### 5. `buildOpenApiDocument` becomes `async` and awaits block discovery
The emit now reads the block registry. Awaiting `ensureBlocksDiscovered()` inside it means no caller can forget to. Its four callers await it: the emit script, `openApiSpec`, `everyRouteInSpec` and `requestMessages.test`. None of them mocks the registry.

### 6. The browser
`web/src/flows/liveFieldIssues.ts` replaces `web/src/flows/fieldChecks.ts`:
- It looks the node's type up in `zFlowBlockFieldRules.shape`, through a `Map` so a type named `constructor` finds nothing.
- It parses `node.data` once per node and takes each field's first issue through `fieldProblems`.
- It keeps the two things that aren't rules:
  - a field its `visibleWhen` hides says nothing;
  - an empty field with a resource-key sidecar is the server's call, found by name.

A type the SDK doesn't know (a block added without `pnpm sdk:generate`) gets no live checks. That is an under-report, and the stale-SDK gate fails the suite on it.

`useFlowIssues` is untouched apart from its import and doc. `liveFieldIssues(nodes, catalog, edited)` keeps its signature. "Only fields edited since the last server answer" and the answer ordering are the hook's, and its 7 tests stay the spec.

### 7. Hand-authored limits on `BlockConfigField` stay
This step does **not** make `maxLength`, `optional`, `minEntries` or `maxEntries` dead. They drive control affordances, not refusals:
- the input's `maxlength` attribute and the tokens hint;
- the add button's capacity and the "Needs at least N." hint;
- whether clearing removes the key.

`conformance.ts` already holds each one to the schema. Retiring them means the controls reading bounds off the generated rules, which belongs with step 6. Recorded as a follow-up.

## Scope

### Server
- **`src/features/flows/logic/blockFieldRules.ts`** replaces `fieldChecks.ts`. It holds:
  - the keyword classification;
  - `fieldJsonSchemas` (kept, cached);
  - `browserFieldRules(definition)`: per drawn field, the kind, the worded limits and the regex check, which throws on the gate failures above;
  - `fieldRuleSentence`;
  - `fieldRuleIssueMessage`.
- **`flowReadiness.ts`** passes `fieldRuleIssueMessage` as `issueMessage`.
- **`src/web/api/flowBlockFieldRules.ts`** (new): `flowBlockFieldRulesSchema()` builds the library-zod component from `browserFieldRules` over every registered block.
- **`openApiDocument.ts`:** async, awaits discovery, registers `FlowBlockFieldRules`, then attaches messages.
- **`requestMessages.ts`:** walks `type: 'schema'` definitions too.
- **`nodeRoutes.ts`:** loses `DERIVED_MEMBERS` and `fieldChecks`. `NodeDescriptor` is the manifest minus `NON_WIRE_MEMBERS` again.
- **`scripts/emitOpenApi.ts`** awaits the build.

### Web
- `web/src/flows/liveFieldIssues.ts` (above). `useFlowIssues.ts` imports it.
- `web/src/api/types.ts` loses `fieldChecks`, `FIELD_CHECK_RULES`, `FieldCheckRule`, `FieldCheck`, and the `NODE_DESCRIPTOR_KEYS` entry.

### Deleted (grep for every name after)
- `fieldChecks.ts` on both sides.
- `deriveFieldChecks`, `fieldChecksOf`, `failedFieldCheck` (both sides), `fieldCheckIssueMessage`, `FIELD_CHECK_RULES` (both sides), `FieldCheck`/`FieldChecksByKey`/`FieldCheckRule`, `withMessage`, `DERIVED_MEMBERS`, and `fieldIssue`'s old body.
- The `FieldCheckRule` row in `nodeDescriptorDrift.test.ts`.
- `DERIVED_MEMBERS` in `nodeRoutes.test.ts`.
- `fieldChecks: {}` in 8 web test fixtures.
- `src/features/flows/logic/__tests__/fieldChecks.test.ts` and `web/src/flows/__tests__/fieldChecks.test.ts`, replaced below.

### Tests
- **`src/features/flows/logic/__tests__/blockFieldRules.test.ts`** (the gates; they live beside the authority):
  - Rules derive for every registered block. Fixtures prove that each throw fires: an unclassified keyword (`multipleOf`), an undrawn export, a pattern with no regex check, two regex checks.
  - **The SDK carries every block:** the keys of `zFlowBlockFieldRules.shape` equal the registered types. This is the precondition that keeps the next case from passing vacuously.
  - **The browser never flags what the server accepts, and words it as the server does.** Every block, every drawn field, probes around every limit, plus:
    - the empty values;
    - numeric strings `'0'`, `'5'`, `'1.5'`;
    - pattern probes: `'1abc'`, `'a b'`, `'_x'`, `'#00a2fG'`, `'#00A2FF'`, a backslash, a non-ASCII letter.

    The browser side is `liveFieldIssues`' `fieldIssue` running the generated zod. The server side is `flowReadinessIssues`. The case asserts that the browser flagged a non-zero number of probes.
  - **A picker with a declared-resource sidecar:** nothing in the browser, nothing on the server (kept).
  - **Server wording:**
    - "Fill this in." for absent and for `''`;
    - "Can't be empty." for an optional `''`;
    - the block's own sentence for a pattern;
    - the issue's own bound;
    - the coerced-field sentences (below).
- **`src/web/api/__tests__/flowBlockFieldRules.test.ts`:**
  - the component has every block and every drawn field;
  - a coerced field is `{}`;
  - a pattern carries the block's sentence in `x-messages`;
  - a fixture block whose regex message is a function fails the emit, naming the component path, block and field.
- **`web/src/flows/__tests__/liveFieldIssues.test.ts`:** `action.setVariable.textValue` (max 1000, `visibleWhen`) checked while shown, ignored while hidden; only edited fields.
- **`useFlowIssues.test.tsx`:** drop the hand `fieldChecks`. It already uses the real `action.sendDM`.
- **`requestMessagesInSdk.test.ts`** counts every spec sentence in `zod.gen.ts`, so it covers the new ones unchanged.
- **e2e:**
  - `web/e2e/flowIncomplete.test.tsx` "checks a field as the operator types…" must still pass. It is now driven by the generated rules.
  - Add a case: a bad variable name shows the block's own sentence before the field is left.

### Docs
- **`docs/contracts/block-authoring.md`:**
  - Rewrite "Your schema is checked in the browser" for the build-time path. It states the one new step: run `pnpm sdk:generate` (which `pnpm dev` runs) after adding or changing a block, or the stale-SDK gate fails. The author still writes nothing outside the directory.
  - Replace the mirrors-table row.

## Behaviour changes

- **Patterns are checked as the author types:** the variable-name sentence and "Colour must be a hex value like #00A2FF". Before, they appeared only on blur. The sentences are unchanged.
- **The server words coerced number fields** (`level`, `amount`) with the rule sentences, where it used to send zod's own:

  | Value | Before | Now |
  | --- | --- | --- |
  | `'0'` | `Too small: expected number to be >=1` | `At least 1.` |
  | `'1.5'` | `Invalid input: expected int, received number` | `Whole numbers only.` |
  | over the maximum | zod's `Too big: …` | `No more than N.` |

  These are the existing sentences applied to the same rule whatever control holds it.
- **Absence of a required plain string with no minimum** would now read "Fill this in." instead of zod's sentence. No block has one.
- **Nothing else.** Every other sentence, every placement, and when errors show are unchanged.

## Checks (planned)
- **Suite** against the baseline (3,039 pass, 1 known failure).
- **Typechecks:** root `tsc` the same 17, `typecheck:e2e` the same 4, web `tsc -b` and the SDK typecheck clean.
- **`pnpm sdk:generate`** twice gives identical output.
- **Sabotage**, each restored and regenerated byte-identical:
  1. a strict number on a coerced field → the parity case fails on `'5'`;
  2. a different "Fill this in." in the wording → the spec gate, the stale SDK and the e2e fail;
  3. a dynamic regex message in a fixture block → the emit fails naming block and field;
  4. one block left out of the component → the precondition fails;
  5. a pattern source altered in `zod.gen.ts` → the pattern probes fail;
  6. the visibility skip removed → the web test fails;
  7. the sidecar forgiveness removed → the sidecar test fails.

## As built

**The design is as planned, with three changes.** Each was forced by evidence found while building. Where they contradict §2, §5 or §6 above, this section is the record.

### 1. The whole-number rule travels; it is not server-only
- **Why:** the first parity run failed on `durationMs = 2592000000.5`.
  - The server's `.int()` aborts the parse there, so it says only "Whole numbers only.".
  - A browser schema with bounds and no `.int()` said "No more than 2592000000." instead.
  - That is a server sentence, but not the one the server picks for this value.
- **What changed:**
  - `requestMessages.ts` gains an `integer` x-messages keyword. zod-to-openapi writes `.int()` as `type: 'integer'`, and the sentence travels beside it. `zodMessageResolvers.ts` mirrors it, and the vocabulary test holds the two copies equal.
  - The number resolver emits `z.number().int('…')` where hey-api writes `z.int()`. `z.int(message)` would also word a value that isn't a number, which the server's `.int('…')` doesn't.
  - `z.int('…')` as a format schema still fails the emit, for the same reason.
- **Scope:** this widens the step-4 contract for every route, not just blocks. `.int('…')` on a request field used to fail the emit and now travels.
- **Tests:**
  - `requestMessages.test.ts`: the old `.int('…')` failure case is now `z.int('…')`, plus a new "words a whole-number rule" case.
  - `zodMessageResolvers.test.ts` gains a `whole` fixture, held to hey-api's own output apart from the base.

### 2. A field with no rule but its type is `unchecked`
- **Affected fields:** enums, bare strings, and formats.
- **Why:** a type check alone yields zod's wrong-type sentence. For an enum the server sends "Invalid option…" instead, and the parity case caught that.

### 3. The rules are handed in, not imported
- `liveFieldIssues(nodes, catalog, edited, rules)` and `fieldIssue(…, rules)` take `zFlowBlockFieldRules.shape`. `useFlowIssues` passes it.
- **Why:** root `tsc` cannot resolve `@brattybot/web-sdk`. Importing the SDK into a file the root gate imports added an 18th root error.
- **How the gate stays honest:** it imports the generated `zod.gen.ts` by path and passes the same object the hook passes.
- The lookup is `Object.hasOwn`, not a `Map`.

### Also
- **The server sentence for a cleared coerced field is kept.**
  - **What the review found:** a `text` box over `z.coerce.number().min(1)` writes `''`, which zod reads as 0. The old evaluator said "Fill this in."; issue mapping first said "At least 1.".
  - **The fix:** `ruleBehind` words `''` on a required number field as `required`. This applies to number fields only. String `''` is worded by `minLength`, which the browser carries.
  - **Pinned:** `level ''` and `amount ''` both give "Fill this in.".
- **Two `.regex()` on one field** export as `allOf`. The derivation names that case directly ("more than one `.regex()`") rather than calling `allOf` an unclassified keyword. Classifying it as server-only would quietly drop both patterns. A fixture pins it.
- **`buildOpenApiDocument` has five callers,** not four: `flowBlockFieldRules.test.ts` is the fifth.
- **Names:**
  - the server's per-field type is `FieldBrowserRules`;
  - the derivation is `browserFieldRules()`;
  - `BlockSchemaSource` is exported and reused by the emit and both tests.

### Behaviour changes, final
- **Patterns are checked as the author types.** Covered by the e2e "checks a pattern as the operator types". The sentences are unchanged:
  - the variable-name sentence ("A name must start with a letter and use only letters, numbers and underscores — that is what {{var.name}} can address.");
  - "Colour must be a hex value like #00A2FF".
- **Whole numbers in a duration are checked as the author types.** The sentence is "Whole numbers only.". The duration control writes whole milliseconds, so in practice this is not reachable from the UI.
- **Coerced number fields** (`level` in Level Reached and Level At Least, `amount` in Award XP) are not checked live. Before, they effectively weren't either. The server's sentences for them:

  | Value | Before | Now |
  | --- | --- | --- |
  | `''` | `Fill this in.` | `Fill this in.` (unchanged) |
  | `'0'` | `Too small: expected number to be >=1` | `At least 1.` |
  | `'1.5'` | `Invalid input: expected int, received number` | `Whole numbers only.` |
  | over the maximum | `Too big: expected number to be <=N` | `No more than N.` |
  | `'lots'` | `Invalid input: expected number, received NaN` | unchanged |

- **Request routes:** `.int('…')` now travels to the browser instead of failing the emit. No route uses it yet.
- **Everything else is unchanged:** every other sentence, all placement, and the edited-since-last-answer rule.

### Checks
- **Suite:** 3,053 of 3,055 pass in a quiet run after the review fixes. The 2 failures are the known `ciBranchProductDiff` and the date-dependent birthday "skips overlapping runs".
  - **A parallel-load flake:** an earlier run while files were being edited saw hook timeouts in `levelUpDispatch`, `memberJoinDispatch`, `reactionAddDispatch` and `nodeRoutes` (block discovery over 10 s under load). Re-run alone, they pass.
- **Typechecks:** root `tsc` has the same 17 errors (diffed); `typecheck:e2e` the same 4; web `tsc -b` and the SDK typecheck are clean.
- **Generation:** `pnpm sdk:generate` run twice gives byte-identical output (hashes of the spec and all 19 generated files).
- **e2e:** `web/e2e/flowIncomplete.test.tsx` passes, including the new pattern case.
- **Sabotage.** Each was restored, and the regenerated output was hash-identical to the baseline:
  1. **The coercion check removed:** the parity case failed on `level = "5"` for both level blocks ("expected number, received string" where the server says nothing).
  2. **"Fill this in." reworded on the server only:** the spec gate and the parity and wording cases failed. **The e2e did not.** Its "Fill this in." comes from absence, which this sabotage did not touch, so the plan's claim about the e2e was wrong.
  3. **The component walk skipped in `requestMessages.ts`:** `flowBlockFieldRules.test` (sentences, the dynamic-message and flag failures) and the spec gate failed.
  4. **One block left out of the component:** the "ships a rule set for every block" precondition and the component test failed.
  5. **`zod.gen.ts` patterns altered**, one looser (variable name) and one stricter (colour): the pattern case failed in both directions. Repeated after the review rewrite of that case, with the same result.
  6. **The visibility skip removed:** the web test, the parity case and the pattern case failed.
  7. **The sidecar forgiveness removed:** the sidecar case failed.
  8. **The integer resolver disabled:** the resolver test, `requestMessagesInSdk` (the sentence went missing from `zod.gen.ts`) and the parity case failed.
  9. **Patterns kept out of the component:** the e2e pattern case and the pattern case failed.
  10. **Hidden fields probed without their sibling set** (added after review): the per-field "no probe tripped it" guard failed, naming `condition.timeSince › timeVariable`.
- **Review:** one pass, with `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` run directly. Neither found anything Critical or High.
  - **Fixed:**
    - the cleared coerced-field sentence (Medium);
    - the `allOf` / two-regex message and its missing test (Medium);
    - confusable names (Medium, partly: web `BlockRuleParser`, server `FieldBrowserRules`);
    - plan mismatches (this section);
    - hidden fields that were never probed, with a per-field "something tripped it" guard replacing the global count;
    - the rule-order assumption noted in `flowBlockFieldRules.ts`;
    - the explicit return type;
    - the shared `BlockSchemaSource` type;
    - the redundant discovery in a test;
    - a test name;
    - the walk comment.

### Follow-ups
- **Hand-authored limits on `BlockConfigField`** (`maxLength`, `optional`, `minEntries`, `maxEntries`) stay; see decision 7. The controls could read bounds off `zFlowBlockFieldRules` once the builder is on the SDK (step 6).
  - The "Needs at least N." list hint is a browser sentence beside the server's "Add at least N entries.". This predates this step. When an edited list is emptied, both show.
- **The step-4 x-messages change rides in this step.** The `integer` keyword is a self-contained change to `requestMessages.ts`, `zodMessageResolvers.ts` and their tests. The maintainability reviewer suggested committing it separately, ahead of the block work.
- **`isFormatSchema`** in `requestMessages.ts` decides "no keyword for a format schema" in the caller, after `keywordsFor` has answered (review Low). It is left as is.
- **Walk failure labels** read `components.schemas .action.pickRandom.outputKey`. The component name is not in the label, and dots in block types blur the block/field boundary (review Low).
- **The browser shows a field's first failing rule, in the order the derivation writes them.** A block written `.regex().min(1)` would show a different first sentence than the server's first. The parity case checks inclusion, not order (review Low).
- **`blockWith`** is duplicated across the two test files.
- **`/api/nodes` is still on the bridge.** Step 6 moves the builder onto the SDK. The rules seam (`zFlowBlockFieldRules`, handed to `liveFieldIssues`) is already in place.
