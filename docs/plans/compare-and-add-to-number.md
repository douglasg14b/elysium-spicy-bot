# Compare, and Set Variable's "Add to number"

> **Status**: Planned 2026-10-03
> **Builds on**: [set-variable-and-time-since.md](set-variable-and-time-since.md) (Set Variable, `variableSelect`, Time Since)

## What the operator gets

- **Compare**: a condition that checks a variable and branches. Pick a variable, a comparison,
  and something to compare it to. It has three exits: **Yes**, **No** and **Not set**.
- **Set Variable → Add to number**: add to a number variable, or subtract with a negative
  amount. Together with Compare and a wire back to an earlier block, this lets a flow count
  and stop a loop ("try three times, then give up").

Both are generic. Neither knows about loops; a loop is just a wire back to an earlier block,
which graphs already allow.

## Decisions (Douglas, 2026-10-03)

- **Comparisons:** is, is not, more than, less than, contains. No at-least / at-most.
- **Never set:** Compare leaves by its own **Not set** exit, like Time Since's No record.
- **Add to number ships in this step.** Adding to a variable that was never set starts from
  0, so "add 1" gives 1. Setting a variable to 0 explicitly stays allowed: Number already
  takes `0`, and only blank is refused.
- **The per-run visit cap stays at 100** (`FLOW_MAX_NODE_VISITS`, counted across waits). A
  loop of five blocks gets about twenty rounds.

## Decisions made in planning (not asked)

- **Text comparisons ignore case** (is, is not, contains), matching Message Sent's
  "contains". Numbers compare as numbers.
- **The compared-to value is typed text with tokens**, so `{{var.other}}` compares two
  variables without a second picker. An unset token there fails the run by name, as it does
  in all copy. That is a wiring mistake, not a branch.
- **Not set is `undefined` or `null`.** `''` is a value: Time Since treats empty as "no
  record" because an empty string cannot be a time, but empty text is a legitimate thing to
  compare.
- **Not set does not warn when left unconnected.** Time Since warns on a saved-time source,
  but Compare's source is always a variable, and its most common uses (a counter set before
  the loop, a value a trigger always provides) are never unset. A warning on every Compare
  card would be the over-warning the memory note "over-warning does not degrade safely"
  forbids. A run landing on an unconnected Not set ends, as any unconnected exit does.

## Contract change — `variableSelect` without a kind

Today `variableSelect` requires `valueKind`, and save refuses a name that any recording
block records as a different kind, kindless included. Set Variable's text, number and
boolean outputs are kindless, so Compare could not pick them.

- **`valueKind` becomes optional on the `variableSelect` arm.** If it is absent, the field
  takes **any variable**, of any kind or none. Mirror the change in `web/src/api/types.ts`
  and add it to the drift gate's key list if needed (`nodeDescriptorDrift.test.ts`).
- **Save (`graphValidation.ts`, the `variableSelect` arm):** without a kind, skip
  `kindIssue`. The path rule still applies: the name must be recorded by a block that can run
  first on a path to here.
- **Conformance:** "names a real kind" checks only when a kind is declared. The
  schema-spelling check is unchanged.
- **Builder (`VariableSelectControl.tsx`):** without a kind, offer every variable in scope.
  The wording drops the noun: "Pick a variable", "No variables before this block…". The
  stale-name hint stays.
- **`block-authoring.md`**, "Reading a variable by name": document that the kind is optional,
  and what that means for save.

## Block: Compare (`blocks/conditionCompare/`, type `condition.compare`)

| Field | Control | Notes |
|---|---|---|
| `variableName` | `variableSelect`, no kind | Required. Uses the shared name spelling (`VARIABLE_NAME_SHAPE`). |
| `operator` | `select` | `is` (default), `isNot`, `moreThan`, `lessThan`, `contains`. |
| `value` | `text`, `rendersTokens` | Max 1000 characters, like Set Variable's text. |

**Save-time refinements:**
- `moreThan` / `lessThan` need a non-blank value. If it contains no `{{`, it must parse with
  `parseAuthoredNumber` (export it from `actionSetVariable` or move it to a shared spot
  beside `variableName.ts`).
- `contains` needs a non-blank value. Empty would always say Yes.
- `is` / `isNot` accept an empty value, meaning "is empty".

**Run:**
1. Read `context.variables[variableName]` with `Object.hasOwn`. If it is `undefined` or
   `null`, leave by `notSet`.
2. Text form of the variable: strings as-is, numbers and booleans through `String()`. Object
   values (if the bag can hold any) fail by name.
3. Then, by operator:
   - **is / is not:** if both sides parse as numbers, compare numerically, so `5` is `5.0`.
     Otherwise compare the text, ignoring case.
   - **more than / less than:** both sides must be numbers: a JS number, or a string
     `parseAuthoredNumber` accepts (a text answer of "5"). Otherwise fail the run, naming the
     variable and what it holds, or the value as rendered.
   - **contains:** the variable's text contains the rendered value, ignoring case.

**Exits:** `true` Yes (positive), `false` No (negative), `notSet` Not set (caution, no
`warnIfUnconnected`).

**Other manifest details:** `outputs: []`, `requires: []`, `canSuspend: false`. The card
summary reads like "count · less than · 3".

## Set Variable: Add to number

- Add `'add'` to `SET_VARIABLE_VALUE_TYPES`, labelled **Add to number**.
- `numberValue` is shown for `number` and `add`; the refine checks it for both.
- **Run:** the current value is `undefined` or `null` → 0; a number → itself; a string
  `parseAuthoredNumber` accepts → that number. Anything else fails by name ("`x` holds
  "abc", which is not a number"). Write the sum as a JS number. The output stays kindless.
- The description and card summary mention adding ("count · Add to number · 1").

## Tests

- **Compare** (block unit test, beside `conditionTimeSince`'s):
  - every operator, both directions;
  - numeric versus text `is`;
  - case-insensitive matching;
  - a token on the right-hand side;
  - Not set for undefined and null;
  - `''` compared as a value;
  - a non-number failing more than / less than, on both sides;
  - the save-time refinements.
- **Add to number:** a fresh variable gives 1; adds to an existing number; adds to a numeric
  string; a negative amount subtracts; a non-number fails by name; setting 0 explicitly
  still saves and writes 0.
- **Contract:**
  - conformance accepts a kindless `variableSelect` and still rejects an unknown kind;
  - save accepts a kindless field reading a text variable, and still refuses a name that
    is only recorded after the block;
  - the drift gate stays green.
- **Builder:** `VariableSelectControl` without a kind offers variables of every kind.
- **One loop end to end** (executor level): Set Variable `count` = 0 → Add 1 → Compare
  `count` less than 3 → Yes wires back to Add. The run completes via No with `count` = 3,
  inside the visit cap. Plus one loop that never stops, failing at the cap.
- `SHIPPED_BLOCK_TYPES` and any block-type lists gain `condition.compare`.

## Out of scope

- Comparing two picked variables without tokens.
- At-least / at-most.
- Raising the visit cap.
- A loop-specific block.
