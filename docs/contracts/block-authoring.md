# Contract — Authoring a flow block

- **Status**: Active (2026-09-12)
- **Applies to**: `src/features/flows/blocks/`
- **Audience**: anyone adding a capability to the flow engine

A **block** is a definition — one thing a flow can do. A **node** is an instance of a block
placed on someone's canvas. This document is the whole contract for writing a block. If you
can read this, you can add one; if you find yourself needing something it does not describe,
see [When the contract cannot express what you need](#when-the-contract-cannot-express-what-you-need)
— that is a real part of the process, not a failure.

## The one-directory rule

Adding a block means **creating one directory** and nothing else:

```
src/features/flows/blocks/actionRenameChannel/
    index.ts          # exports `block`
    __tests__/        # optional, and yours
```

No registry to append to, no barrel line to add, and **no file under `web/src/flows`**. The
registry finds your block by scanning this tree at startup, and the builder draws its palette
entry, its card, its form, and its output handles from what your manifest declares. If you ever
have to edit a shared file to make a block appear, something has regressed — say so rather
than editing the shared file.

Two rules the scan enforces, both as named errors rather than a block quietly missing:

- the directory must contain `index.ts` exporting a const named **`block`**
- no two blocks may declare the same `type`

A directory whose name starts with `_` or `.` is skipped, which is how scratch and fixture
trees live here harmlessly.

### Discovery happens once, at startup

Because the scan reads the filesystem, it is asynchronous, and the registry refuses a read that
arrives before it finishes rather than reporting your block as missing. `initFlows()` awaits
discovery and `bot.ts` awaits `initFlows()` before the web server starts, so nothing you write
inside a block or a handler has to think about it.

It matters in exactly one place — **a test that reads the registry**, directly or through the
executor or save-time validation:

```ts
beforeAll(async () => {
    await ensureBlocksDiscovered();
});
```

Skip it and the failure names itself. Calling it more than once is free; it scans once and hands
every later caller the same registry.

## The manifest

`block` is a `BlockManifest<TConfig>`, where `TConfig` is your validated config — what your
schema produces and what your `run` receives. Every member is required unless the table below
marks it optional; arrays are declared empty rather than omitted, so a reader can see you meant it.

| Member | What it is |
| --- | --- |
| `type` | Stable identifier, `<kind>.<camelCaseName>` — e.g. `action.assignRole`. **Every saved graph stores this string.** Renaming it breaks existing flows, so choose it once. |
| `kind` | `trigger`, `condition`, or `action`. Palette styling, and which gateway dispatchers treat it as a starting point. It does **not** change what your entry point looks like. |
| `label` | Short name shown in the palette, on the card, and in the inspector header. |
| `description` | One line, in the product's voice — the same voice as the rest of the bot. Do not write it generic. |
| `group` | Palette section: `triggers`, `conditions`, or `actions`. |
| `icon` | One emoji. It is the glyph in the palette and on the card. |
| `configSchema` | A Zod **object** schema. This is the authority on `node.data`: it validates at save time and again before your block runs. |
| `configFields` | The form, in the order the inspector should render it. See [Config fields](#config-fields). |
| `cardSummary` | **Optional.** The one-line config summary on the canvas card, e.g. `Assign @Moderator`. See [Card summary](#card-summary). Omit it and the card falls back to "Click to configure" — fine for a block with nothing worth summarising, but check the real thing looks right before deciding that's you. |
| `note` | **Optional.** A block-level aside rendered under the form — presentation only, never read by the engine. For what is true of the block *as a whole*: a caveat spanning every field, or the reassurance that a block with no fields is meant to have none. Prefer a field's own `description` when the copy is about one field; a note that would read identically under a single control is a description wearing a disguise. Omit it rather than declaring it empty — conformance rejects a present-but-empty one. |
| `handles` | Every way a run can leave your block. See [Output handles](#output-handles). |
| `outputs` | Values your block writes for later blocks to read, via `context.setOutput`. Read by the builder to offer an author the variables in scope. Discriminated on `naming` — `fixed` carries the name, `authored` names the config field holding it. See [Run variables](#run-variables). |
| `requires` | Run context you cannot work without. See [Context requirements](#context-requirements). |
| `capabilities` | Discord permissions the bot needs for your block to work. Declared, not yet enforced. |
| `startedBy` | **Optional. Triggers only.** What fires you: `buttonClick`, `memberJoin`, or `reactionAdd`. The gateway dispatchers select on this, so a new trigger for an existing source needs no dispatcher edit. Leave it off any condition or action. |
| `canSuspend` | Whether `run` may park the run. State it truthfully; conformance holds you to it. |
| `run` | The entry point. See [The entry point](#the-entry-point). |

**Your manifest is served to the browser.** `GET /api/nodes` sends every member except
`configSchema` and `run`, so the builder can draw your node — palette entry, card, and
inspector form — from what you declare rather than from a copy of it. That is a subtraction,
not a list: a member added to `BlockManifest` is public to every authenticated dashboard user
the moment it exists. A server-only member must be named in `NON_WIRE_MEMBERS` in
`src/web/api/nodeRoutes.ts`, which will not compile until that route withholds it as well —
the list and the route cannot drift.

## The entry point

Every block — trigger, condition, action, suspending or not — implements exactly one method:

```ts
run(config: TConfig, context: FlowRunContext): Promise<FlowStepOutcome> | FlowStepOutcome
```

`config` is already validated against your schema. Return one of three outcomes:

```ts
{ kind: 'continue' }                       // carry on out of the default handle
{ kind: 'continue', handle: 'true' }        // carry on out of a named handle you declared
{ kind: 'suspend', suspension: { … } }      // park this run
{ kind: 'fail', error: 'why, readably' }    // stop this run, with a message worth reading
```

That is the complete set, and it is **frozen**. There is deliberately no "finished
successfully" or "stopped deliberately" outcome: a flow ends when its last block runs, and an
author ends a path by wiring nothing after it. Whether a journey *succeeded* lives in the roles
someone holds and the records the flow wrote — never in the engine's own state.

Notes that save time:

- A **trigger** returns `{ kind: 'continue' }`. Triggers are pass-through; they exist so the
  graph has a starting point.
- A **condition** returns `{ kind: 'continue', handle: 'true' }` or `'false'` — declare both
  handles.
- Throwing is allowed. The executor records the error against your node and fails the run. Use
  `fail` when you know what went wrong and can say it usefully; throw when you genuinely did
  not expect it.
- `run` may be synchronous. Do not make it `async` for decoration.

### Parking a run

A suspending block sets `canSuspend: true` and returns what it wants to wait for. It never
persists anything itself — the executor owns where to resume, the visit budget, and the log:

```ts
{ kind: 'suspend', suspension: { wakeAt: new Date(Date.now() + config.durationMs) } }
{ kind: 'suspend', suspension: { waitKind: 'reactionAdd', waitConfig: config } }
```

Include `wakeAt` to be woken by time, `waitKind`/`waitConfig` to be woken by a Discord event,
or both when an event-wait also has a timeout. A parked run survives a restart, so assume
nothing about what is still in memory when you wake.

### Parking on controls you posted — set `waitMessageId`

If your block parks by **posting a message with buttons**, it must also return the id of what
it posted:

```ts
const posted = await context.channel.send({ /* … */ });
return { kind: 'suspend', suspension: { waitMessageId: posted.id } };
```

This is not optional bookkeeping, and **nothing will tell you if you forget it**. A run can park
at the same node twice — an author who wires a branch back to your block asks again — and every
other column is identical across those two parks: same `resumeNodeId`, same `suspended` status.
The message id is the only value that differs, which makes it the only thing that can tell one
park from the next.

Two consequences follow, and a block that omits it silently loses both:

- **A press from the earlier park advances the run a second time.** `claimForResume` narrows its
  conditional `UPDATE` on this id, so a claim names *a park* rather than a run. Without an id
  there is nothing to narrow on.
- **The buttons are never disabled.** `engine/waitMessageControls.ts` releases the controls when
  a park closes by any route, and it needs to be told which message to edit.

The dispatcher that handles your block's presses must pass the message the press arrived on as
`resumeFlowRun`'s `claimedWaitMessageId`. `action.prompt` and `engine/flowChoiceDispatch.ts` are
the worked example; copy their shape.

Note that the disabling is **tidiness, not the guarantee** — a client holding a stale render can
still send the press, and the park-scoped claim is what makes that harmless. Do not treat a
successful edit as a security boundary.

### Waking up

**A parked run resumes at your node, not the one after it.** Your `run` is called a second
time, with `context.resume` set to why you woke:

```ts
run(config, context) {
    if (context.resume) {
        // Second call: we parked earlier and something has now happened.
        return context.resume === 'timeout'
            ? { kind: 'continue', handle: 'timeout' }   // gave up waiting
            : { kind: 'continue' };                      // the event arrived
    }

    return { kind: 'suspend', suspension: { /* … */ } };
}
```

`context.resume` is `'event'` when the gateway event you asked for arrived, and `'timeout'`
when your `wakeAt` came due first. A block that waits only on the clock only ever sees
`'timeout'`, and can treat any resume as "carry on".

Two things follow, and both matter:

- **Check `context.resume` before anything else.** Forget it and you park again immediately,
  every time, forever. Conformance drives this directly — it parks your block, then wakes it
  with each reason and fails you if you ask to park again — so the mistake is caught, but only
  once you have a conformance run over your block.
- It is set **only** on the node that parked, and only when that block declares `canSuspend`.
  The nodes your run reaches afterwards see a context with no `resume`, so they cannot mistake
  your wake-up for their own.

This is what keeps the executor free of block names: it hands you the reason and follows
whichever of *your* declared handles you answer with, exactly as it would a condition's.

## Config fields

Each entry names a `node.data` key and picks a control. The **schema validates; the field list
only renders** — never the other way round.

| `control` | Stores | Use it for |
| --- | --- | --- |
| `rolePicker` | role id | any role. Never make someone type a snowflake. |
| `channelPicker` | channel id | any channel. Same. |
| `text` | string | one line. `maxLength`, `placeholder`, `rendersTokens`. Set `optional: true` when the schema is `.optional()` over a non-empty floor (`z.string().min(1).optional()`, a url) — clearing the box then removes the key instead of writing `''`, which such a schema rejects and `validateNodeData` refuses the whole save over. A field whose description says "leave empty for none" needs it. |
| `longText` | string | a message body. `maxLength`, `placeholder`, `rendersTokens`. |
| `duration` | milliseconds | any span. Shows a number plus a unit, so nobody hand-computes `604800000`. Set `optional: true` when absence is meaningful — clearing it removes the key rather than writing a zero. `placeholder` hints the empty number box — worth having chiefly on an `optional` field (e.g. `'No limit'`), where an empty box is a real setting rather than a blank. A field with a `defaultValue` is never empty, so a hint for it could never render. |
| `segmented` | string | a few short choices, all visible at once. Needs `options`. Roughly two to four, but **label width decides**: segments split the inspector's width evenly, so one-word labels fit and full clauses do not. |
| `select` | string | a dropdown. Needs `options`. Use it once the labels are long enough to be unreadable side by side, or there are more of them than segments can hold — `action.waitForEvent` has only three choices but picks this, because "They click a flow button" cannot be squeezed into a third of the panel. |
| `colour` | `#RRGGBB` | a colour. `swatches` to suggest some. |
| `textList` | `string[]` | an ordered list of short strings an author types. `placeholder`, `maxLength` (of **one entry**), `minEntries`, `maxEntries`, `addLabel`. |
| `objectList` | `Record<string, unknown>[]` | an ordered list of **records** — `textList` one dimension up. Needs `columns`; also takes `minEntries`, `maxEntries`, `addLabel`. See below. |
| `eligibility` | an `Eligibility` object | who is allowed. Declares no options: the principals are a closed vocabulary the control reads from `engine/eligibility.ts`. |

### A list of records — `objectList`

Use it when one entry is several values that belong together, the way an embed
field is `{ name, value, inline }`. Each entry carries the same declared
`columns`, and a column is `text`, `longText` or `toggle` — nothing else. A
column wanting a role picker would be a form inside a list row, which is a
different control with a different layout problem rather than a wider member
here.

```ts
{
    key: 'fields',
    label: 'Fields',
    control: 'objectList',
    columns: [
        { key: 'name',   label: 'Heading', control: 'text',     maxLength: 256,  rendersTokens: true },
        { key: 'value',  label: 'Text',    control: 'longText', maxLength: 1024, rendersTokens: true },
        { key: 'inline', label: 'Side by side', control: 'toggle' },
    ],
    maxEntries: 25,
    addLabel: 'Add a field',
    defaultValue: [],
}
```

Three things worth knowing before you declare one:

- **`rendersTokens` works per column**, and the expansion is a *separate walk*
  from the scalar one. `isCopyField` narrows to the two single-string arms and
  does not see a column; `copyColumnsOf` is its counterpart, and both the
  executor and save-time validation use them together.
- **Conformance checks the columns against the schema** (`checkFieldColumns`).
  An entry's keys live inside an array element, so the key-for-key agreement
  between `configFields` and the schema's top level does not reach them — a
  column named `title` over a schema expecting `name` would otherwise render a
  row whose every keystroke is discarded at save.
- **The card counts rather than lists.** A record has no single string to show,
  so `cardSummary` renders `3 fields`, taking the noun from the field's own
  `label`.

`defaultValue` is the starting value when a node is dropped on the canvas. It is **schema
input**: if your schema also carries a `.default()` for that key, the two must be the same
value. Declaring the default in one place and not the other is the drift this contract exists
to prevent, so conformance treats disagreement — and a schema default the field forgot to
mirror — as a failure.

## Card summary

The canvas card shows your `label`, then one more line underneath — the current config, at a
glance, without opening the inspector: `Assign @Moderator`, `#general · "Say something…"`,
`Wait 5m`. `cardSummary` is how you say what that line is, without the browser knowing your
`type` or your fields' meaning.

It's an ordered list of **parts**, concatenated with no separator of their own:

```ts
cardSummary: [
    { key: 'roleId', prefix: 'Assign ', emptyText: 'no role picked' },
]
// -> "Assign @Moderator", or "Assign no role picked" before a role is chosen

cardSummary: [
    { key: 'channelId', emptyText: 'no channel picked' },
    { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
]
// -> "#general", or "#general · "Say something…"" once a message is set
```

Each part is **either** a field reference (`key`, naming a `configFields` entry) **or** a
literal (`text`) — never both, never neither. A block with nothing to reference at all still
summarises with a literal: `trigger.memberJoin` declares `[{ text: 'Any new member' }]`.

A field reference renders the field's *current* `node.data` value, resolved and formatted the
way that field's own `control` already implies:

| `control` | Renders as |
| --- | --- |
| `rolePicker` | `@name` |
| `channelPicker` | `#name` |
| `duration` | `5m` (via the same formatter the inspector uses) |
| `segmented` / `select` | the matching option's `label`, not the raw stored value — `action.waitForEvent`'s `eventKind: 'buttonClick'` renders as "They click a flow button", never `buttonClick` |
| `text` / `longText` / `colour` | the raw string value |
| `textList` | the entries joined on ` · `, blanks dropped |
| `objectList` | a count plus the field's own label, e.g. `3 fields` — a record has no one string to show |
| `eligibility` | a short phrase, or nothing at all when the gate is open |

`cardSummary` never repeats that resolution logic; it only says which field, what surrounds it,
and what to show in its place when it's unset:

| Option | Does |
| --- | --- |
| `prefix` / `suffix` | Literal text immediately before/after the resolved value, **only when the value renders** — so it disappears along with the value under `hideWhenEmpty`, rather than leaving a dangling `" · "`. |
| `quote` | Wraps the resolved value in `"double quotes"`. For message-shaped fields. |
| `truncate` | Maximum characters of the resolved value before an ellipsis. Card-summary truncation, not the field's own `maxLength` — a card line is shorter than an inspector field. |
| `emptyText` | Rendered **in place of the value**, still inside this part's `prefix`/`suffix`, when the field is unset — so `prefix: 'Assign '` with `emptyText: 'no role picked'` reads "Assign no role picked". `quote` and `truncate` are skipped, since empty copy is not the author's own text. Omit it and an unset field renders as nothing, which is rarely what you want — declare it. (Under `stopIfEmpty` it *is* the whole line, decorations and all discarded.) |
| `hideWhenEmpty` | Drop this part (and its `prefix`/`suffix`) entirely when the field is unset, rather than showing `emptyText`. For a trailing, genuinely optional detail (`action.sendMessage`'s message preview) where "channel, nothing else" reads better than "channel, no message yet". |
| `stopIfEmpty` | When the field is unset, render only this part's `emptyText` as the **entire** summary and discard every part after it. For when later parts stop making sense without this one — an unlabelled button (`trigger.buttonClick`) has no style worth showing either. Requires `emptyText` — conformance rejects `stopIfEmpty` without it, since otherwise the empty case renders nothing. |

`hideWhenEmpty` and `stopIfEmpty` are mutually exclusive on one part: the first drops just that
part, the second discards the whole line, and a part cannot mean both.

Conformance checks that every `key` here names a real `configFields` entry, that `truncate` is
a positive whole number when set, and that a part is well-formed (exactly one of `key`/`text`,
`hideWhenEmpty` and `stopIfEmpty` not both set). It does **not** check that the composed text
reads well — that's a judgement call, same as `label` and `description`.

## Output handles

```ts
handles: [{ label: 'Next', tone: 'neutral' }]                       // one exit
handles: [                                                          // a condition
    { id: 'true',  label: 'Yes', tone: 'positive' },
    { id: 'false', label: 'No',  tone: 'negative' },
]
handles: [                                                          // an event wait
    { label: 'It happened', tone: 'positive' },
    { id: 'timeout', label: 'Timed out', tone: 'caution' },
]
```

A handle with no `id` is the **default** exit — the edge the graph stores with no source
handle. You get exactly one of those. `tone` is meaning, not colour (`neutral`, `positive`,
`negative`, `caution`); the builder decides what that looks like, so the engine never carries
a stylesheet.

Every block declares at least one handle, including one that usually ends a path: an author
ends the path by connecting nothing to it, not by you declaring no way out.

## Context requirements

`requires` says what your block needs to be present on the run:

- `subject` — the member the run is **about**. Always present, so declaring it is documentation
  rather than a constraint anything can violate.
- `actor` — the member who caused the **current step**, which is not always the subject and is
  not always anybody. **Absent on a resumed run**: the clock woke it, so nobody acted.
- `channel` — where the run is operating. **Absent on a run started by a member join**, which
  happens nowhere in particular, and absent on a resumed run, because a parked run does not yet
  remember where it was.
- `interaction` — the interaction that started it. **Absent on any gateway-started run and on
  every resumed run**, because the token expires when the run parks.

Declaring one of the three that can be absent lets a graph placing your block where it could
never be satisfied be rejected at save time, naming the node and the requirement, instead of
quietly taking the wrong branch.

**On a trigger, `requires` reads the other way round.** A trigger is never reached by an edge,
so nothing upstream could fail to satisfy it — what it declares is what its own event
**establishes**, and save-time validation reads it as the supply side when deciding whether a
downstream block's requirement can be met on that path. A button click establishes an actor, a
channel and an interaction; a member join establishes only an actor. If you add a trigger,
declare everything its event genuinely provides: under-declaring rejects graphs that should be
legal, and over-declaring accepts ones that will misbehave at runtime.

If you find yourself reading something off `context` that you did not declare, declare it.

## Run variables

`context.variables` is a read-only bag of named values earlier blocks produced. It is scalar
only — `string | number | boolean | null` — and that is a deliberate limit rather than an
oversight: a variable holds an id or a reference, never evidence. If you are reaching for a
place to stash a message body or an attachment url, the bag is the wrong home for it.

You **write** to it through the one channel on the context:

```ts
run(config, context) {
    const channel = await openTicketChannel(context.subject);
    context.setOutput('ticketChannelId', channel.id);
    return { kind: 'continue' };
}
```

Four things follow from how that is wired, and each of them has bitten somebody:

- **Keys are flat and yours.** The executor does not qualify them by node id, so
  `setOutput('ticketChannelId', …)` is read back as `{{var.ticketChannelId}}` and nothing else.
  A namespaced store and a flat token cannot both be true. Two nodes writing one key is
  last-writer-wins today; nothing rejects it yet, so pick names that say what they hold.
- **Your writes land after you return.** You cannot read back what you just wrote — you already
  have the value, and a bag that changed mid-`run` would make "what this node was handed" depend
  on where in the function you looked. A block that throws records nothing.
- **It survives a park.** The bag rides the suspension and is reseeded from the run's row on
  resume, so a value written before a wait is readable after it. That is the whole reason
  `setOutput` is a method on the context rather than a slot on the step outcome: a suspending
  block writes on its *resume* leg, when it is returning `continue`.
- **It is size-capped** (`FLOW_MAX_VARIABLES_SIZE`). Over the cap fails the run naming the keys.
  Never a silent drop: a variable that vanished would send a later block down a branch its
  author never drew.

`outputs` **is read** — by the builder, which offers an author the variables in scope at a
node and shows, on your block's own inspector, the `{{var.…}}` token later blocks use to read
what you write. A block that calls `setOutput` and declares nothing produces a variable that
is invisible to whoever has to reference it, so the two are halves of one statement.

Declare each output under the naming that matches how your block gets the name:

```ts
// The block decides the name, and it is the same every run.
outputs: [{ naming: 'fixed', key: 'ticketId', label: 'The ticket' }]

// The author decides, through a config field — `action.pickRandom`'s shape.
outputs: [{ naming: 'authored', fromField: 'outputKey', label: 'The picked option' }]
```

`fromField` names a **config field**, never the variable: the variable is whatever the author
typed into that field, resolved per node by `resolveOutputName`. Conformance rejects a
`fromField` naming no declared field, so a renamed config key fails the suite rather than
silently producing a node whose output nothing can resolve.

Still unchecked: that what you declare is what you actually write. Nothing compares `outputs`
against your `setOutput` calls — declaring one and writing another is a manifest bug found by
reading, and the builder will confidently offer a name nothing produces.

## Copy and `{{tokens}}`

A config field whose value is **copy a member reads** declares `rendersTokens: true`, and the
executor expands its tokens between validating your config and calling `run`. Your block
receives finished text and never learns that tokens exist:

```ts
{ key: 'message', label: 'Message', control: 'longText', maxLength: 2000, rendersTokens: true }
```

Available in this slice, and nothing else:

| Token | Fills in |
| --- | --- |
| `{{subject.mention}}` | A ping for the member the run is about |
| `{{subject.username}}` | Their username, unpinged |
| `{{actor.mention}}` | Whoever caused this step. **Fails on a resumed run**, where nobody did |
| `{{guild.name}}` | The server's name |
| `{{var.<name>}}` | A value an earlier block recorded |

The `text` and `longText` arms carry the flag, as do an `objectList`'s `text` and `longText`
**columns**, and it is **off by default** — which is the right default, because most string
fields are not copy: a message id, an emoji, a button label. Turning it on for one of those would
turn a stray brace into a failed run. Forgetting it on a field that *is* copy is the more visible
mistake: the braces are posted verbatim.

A column's copy is expanded by a **separate walk** from a field's. `isCopyField` narrows to the
two single-string arms and cannot see a column; `copyColumnsOf` answers the other half, and the
executor and `checkCopyTokens` each use both. A failure inside a list names the row an author
sees — `"Fields" Text on entry 2` — because "the Fields field is wrong" is unactionable on a list
of twenty.

Three things fail rather than degrade, all of them naming the node:

- a token outside the table above, **rejected when the flow is saved** — except `{{var.<name>}}`,
  which is still accepted on sight. The builder now warns about a name nothing upstream writes,
  but a *save-time* refusal has to decide what to do with a variable written on only one branch
  of a split, which is a real graph; see `checkCopyTokens` in `engine/graphValidation.ts`
- a `{{var.…}}` nothing recorded by the time your block runs
- copy that exceeds the field's `maxLength` **once rendered** — which is not the length the
  author typed, since `{{subject.mention}}` is 19 characters that expand to about 22

There is deliberately no expression language, no conditionals, and no formatting. A flow builder
is not a template engine.

### Sending rendered copy — pin the mention allowlist

Rendered copy carries **member-controlled text**: `{{subject.username}}` is whatever the member
called themselves. A member named `@everyone` turns any flow that greets them by name into a
guild-wide ping sent with the bot's permissions.

So a block that sends copy passes an explicit allowlist, never a bare string:

```ts
await channel.send({ content: rendered, allowedMentions: { parse: ['users'] } });
```

Use `{ parse: ['users'] }` where `{{subject.mention}}` must still ping the one member it names,
and `{ parse: [] }` for embed bodies, which have no reason to mention anyone. All three shipped
send paths do this — `action.sendMessage`, `action.sendDM`, `action.postEmbed` — and the test
helper `__tests__/support/sentCopy.ts` throws on a bare-string payload so a fourth path cannot
quietly skip it and stay green.

Nothing checks this at compile time. It is the one rule in the copy contract that depends on the
author reading it.

## Where a new graph rule goes

Two functions in `engine/graphValidation.ts`, and picking the wrong one has already caused one
outage:

- **`validateFlowGraph`** — corruption only: dangling edge endpoints, duplicate node ids. It
  runs on **read**, and the repo *throws* from it, so a rule added here makes every flow in a
  guild unloadable the moment one stored row stops satisfying it — not just the bad one.
- **`validateAuthoredGraph`** — everything that makes a flow *wrong* rather than unreadable:
  fan-out, handles a block does not declare, unsatisfiable context requirements. Write path
  only, reached through `validateGraphForWrite` in the repo, so every writer is covered and no
  stored graph is retroactively stranded.

New rule? It is almost always the second one.

## Conformance

```bash
npx vitest run src/features/flows/__tests__/blockConformance.test.ts
```

Conformance is what makes this contract cheap to change: extend the manifest and every block
that has not caught up fails by name. It checks, from your declaration alone, that

- every required member is present and the right shape
- every vocabulary word you used is in its vocabulary
- your declared fields and your schema describe the same config, **in both directions** — a
  declared field the schema ignores, and a schema key no field lets an author set
- every declared default is one the schema accepts, and agrees with any schema default
- your handles are well formed: at least one, no duplicate ids, at most one default, all labelled
- your `cardSummary`, if you declared one, only references fields that exist and is otherwise
  well formed — see [Card summary](#card-summary)

and, when driven with a config and a context, that `run` returns a declared outcome and
continues only by a handle you declared.

One thing it does **not** check: that a handle you declared is actually reachable. Proving that
means driving a block down every path, which needs a config and a context per path that only
you know. Cover your own branches in your own test.

## When the contract cannot express what you need

**Extend the vocabulary. Do not work around it.**

The lists above — kinds, palette groups, control types, handle tones, context requirements,
capabilities — are closed unions, and *that is the extension point*. A block needing a control
nobody has built yet adds it to the vocabulary, implements it once in the builder, and every
future block gets it. A block that instead special-cases around the gap has bought itself a
day and cost everyone the property this contract exists for: the twelfth block is as cheap as
the second.

So, in order:

1. If you need a new control, requirement, capability, or tone: add the member, implement it
   once, document it here.
2. If you need something the manifest has no member for at all: that is a contract change.
   Change the manifest, the conformance suite, and this document together, and migrate every
   existing block in the same change. Two ways to declare one fact must never coexist.
3. If you think you need a fourth step outcome: you almost certainly do not — read
   [The entry point](#the-entry-point) again. If you still do, the block contract is wrong
   somewhere else. Treat it as a report about the contract, not as an enum to append to.

### Extending the vocabulary or the manifest means editing the browser too

The one-directory rule covers **adding a block**. Changing the *contract* — a new vocabulary
member under step 1, or a new manifest member under step 2 — is the case where you do edit a
shared file, because the browser holds a hand-written mirror of the manifest in
`web/src/api/types.ts` (`NodeDescriptor` and the `BLOCK_*` vocabularies beside it).

The mirror exists because the web workspace cannot import the bot's types: one `import type`
from `src/` drags the whole bot tree into `tsc -b` and breaks `pnpm build:web`. So the two are
kept together by `src/web/api/__tests__/nodeDescriptorDrift.test.ts`, which fails naming the
field or union that drifted, in either direction. You do not have to remember this rule — the
test tells you, and it tells you which of the two fixes you want:

- the member is for the builder → declare it in `web/src/api/types.ts` (add it to
  `NodeDescriptor` **and** `NODE_DESCRIPTOR_KEYS`, or to the vocabulary array)
- the member is server-only → add it to `NON_WIRE_MEMBERS` in `src/web/api/nodeRoutes.ts`, which
  will not compile until the route withholds it too

This covers the arms of `BlockConfigField` too, member by member — adding `maxLength` to one
control's arm and not the other side fails, because a member the browser does not declare is one
the inspector cannot read off a field it is being sent.

One gap to know about: the test derives what is served from the blocks that actually exist, so a
**new optional top-level member no block sets yet** is served-as-absent and the test stays quiet
about it. That is the one case you have to carry yourself — declare it in the mirror when you add
it, not when the first block sets it. (It does not apply to the config-field arms, which are
compared against an exhaustive fixture rather than live blocks.)

Everything a manifest declares except `configSchema` and `run` is served to the browser by
`GET /api/nodes`, so a new member is published to every authenticated dashboard user by
default. That is the reason the second option has to be a deliberate act.

Every block that ships is written against this contract — the earlier shape, with three
separate per-kind entry points, is gone. There is one way to declare a block.
