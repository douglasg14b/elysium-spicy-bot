# 5A.2 — Pending resources save, and field-level validation errors

Two problems that are really one problem. Item 1 is "a valid flow is wrongly
rejected"; item 2 is "when a flow *is* rejected, the operator cannot tell which
field did it." Both live in the same save-validation pipeline, so one agent owns
both — splitting them would have each rewrite the other's return type.

## Problem 1 — a declared resource cannot be saved

Reproduce: add a Post Embed node, open the channel picker, choose an entry under
"Declared by this flow — not created yet", save. The save is refused with:

> Post embed channel ID too small. Expect string to have >= 1 character.

**Why.** Picking a declared resource writes the *pair* the sidecar convention
defines (`web/src/flows/controls/PickerControls.tsx:192-201`): `channelIdKey`
gets the resource key, and `channelId` is deliberately cleared to `''` — because
the snowflake genuinely does not exist until install, and leaving a stale one
would look valid to the executor.

But `postEmbedConfigSchema.channelId` is `z.string().min(1)`
(`src/features/flows/blocks/actionPostEmbed/index.ts:91`), and
`validateNodeData` parses every node against its `configSchema` at save time
(`src/features/flows/engine/nodeDataValidation.ts:26`). The two halves of the
sidecar design were never introduced to each other.

This is not specific to Post Embed. Every picker field with a `.min(1)` id has
it: `actionSendMessage.channelId`, `conditionInChannel.channelId`,
`actionAssignRole.roleId`, `actionRemoveRole.roleId`, `conditionHasRole.roleId`,
`triggerReactionAdd.channelId`.

### The fix, and the shape it must take

**Do not** relax the schemas to `.optional()`. That would let a node with no
channel at all save clean, and the emptiness is only acceptable *because*
something else supplies the id later.

Validate the pair instead. A picker field may be empty **only when** its
`*Key` sidecar names a resource **this flow declares**. An empty field with no
sidecar is still an error; a sidecar naming an undeclared key is a *new* error
("names a resource this flow does not declare"), which is a real bug class the
current code cannot even express.

Suggested shape — `validateNodeData` grows an options parameter carrying the
declared resource keys, and skips exactly those `.min(1)` complaints whose path
is a field with a satisfied sidecar:

```ts
validateNodeData(graph, { declaredResourceKeys: ReadonlySet<string> })
```

Reuse `RESOURCE_KEY_SUFFIX` from `src/features/flows/logic/resourceTargets.ts`;
do not re-spell `'Key'`.

`validateGraphForSave` (`src/web/api/flowRoutes.ts:71`) must then load the flow's
declared resources before validating. They live in `journeys`, keyed on the
flow's own id — `journeysRepo.getByKey(guildId, flowId)`. **Note the boundary:**
`src/features/flows/` must never import `src/features/provisioning/`… actually
the rule is the reverse (provisioning must not import flows), so flows reading
the repo is allowed — but prefer passing the keys *in* from the route, keeping
`nodeDataValidation` a pure function. That also keeps it testable without a DB.

**Creation ordering matters.** `POST /flows` validates a graph for a flow that
does not exist yet, so it has no journey and no declared keys — pass an empty
set there. A brand-new flow cannot reference a declared resource it has not
saved yet, so this is correct rather than a shortcut.

### Why this is safe at run time

The executor re-parses `configSchema` before running a node
(`src/features/flows/engine/executor.ts:211`) and fails the run with a logged
error when it does not parse. So a flow saved with an unresolved resource still
refuses to run, loudly, with the resource name in the message. We are relaxing
*save*, not *execution* — the guard that matters is untouched.

Confirm this holds and say so in your report. If you find a path where an
unresolved node could execute against a missing channel, stop and report it
rather than proceeding.

### Tests

- A graph whose `channelId` is `''` and `channelIdKey` names a declared key → valid.
- Same graph, key **not** declared → invalid, message names the resource key.
- `channelId` empty with **no** sidecar → still invalid (the original rule holds).
- Every picker block type above, table-driven, so a seventh block cannot regress.
- Executor: a node with an empty `channelId` fails the run cleanly and logs.

## Problem 2 — validation errors are one opaque string

Today `validateGraphForSave` joins every error into one string and the route
returns `{ error: '<joined>' }` (`src/web/api/flowRoutes.ts:71-90`,
`122`, `153`). `validateNodeData` already knows the node id and the field path
(`nodeDataValidation.ts:29-30`) — it is formatting that information away.

The operator sees a sentence mentioning a field, on a canvas of a dozen nodes,
with no indication of *which* node.

### What to build

**A structured error contract, used end to end.** One shape, defined once:

```ts
type FlowValidationIssue = {
    nodeId?: string;      // absent for whole-graph problems
    field?: string;       // dotted config path, e.g. 'fields.0.name'
    message: string;
};
```

- `validateNodeData` returns these instead of `string[]` (it already has both parts).
- `validateGraphForSave` returns them; the route returns
  `{ error: '<summary>', issues: [...] }`. **Keep `error`** — it is what every
  existing client reads, and dropping it breaks callers for no gain.
- The builder keeps the issues in state, keyed by node id.
- `FlowNodeCard` renders red border + error icon when its id has issues; the
  count goes on the card.
- `NodeInspector` renders each issue under its field, and a node-level list for
  issues whose `field` does not match a rendered control (never silently drop one).
- Selecting an errored node from a summary scrolls/focuses it.

**Make it a reusable pattern, not a Post Embed special case.** The controls in
`web/src/flows/controls/` all take `ControlProps`; add an optional `error?: string`
there and have `renderControl` pass it through, so every control — present and
future — gets field-level errors without its own plumbing. Mantine inputs all
accept an `error` prop, so most controls need one line.

Do not invent a second error channel for `ObjectListControl` / `EligibilityControl`
if the dotted path makes it awkward — render those at node level and note it.

### Tests

- `validateNodeData` yields `nodeId` and `field` for a nested path.
- The route's JSON carries `issues` **and** the legacy `error` string.
- A control given `error` renders it (one representative control is enough).
- Node card shows the error state when its id is in the issue list.

## Out of scope

Sidebar resizing, Resources modal sizing, and resource autocomplete. Other
agents own those files; do not touch `ResourcesPanel.tsx` or the resize work.

`FlowBuilderPage.tsx` is shared with the resize agent — keep your edits tight
and expect to rebase.

## Definition of done

- `pnpm typecheck` clean in both packages (server baseline is 17 pre-existing errors — no new ones).
- `pnpm test` — no new failures (`ciBranchProductDiff` fails already).
- Sabotage-verify both guards: revert the pair-validation branch and watch the
  named test fail; revert the issue plumbing and watch its test fail. Restore.
- Report what you verified and what you did not.
