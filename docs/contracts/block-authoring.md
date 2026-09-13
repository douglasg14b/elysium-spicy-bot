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
schema produces and what your `run` receives. Every member is required; arrays are declared
empty rather than omitted, so a reader can see you meant it.

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
| `handles` | Every way a run can leave your block. See [Output handles](#output-handles). |
| `outputs` | Values your block writes for later blocks to read. Empty for now — blocks have nowhere to write until run variables exist. |
| `requires` | Run context you cannot work without. See [Context requirements](#context-requirements). |
| `capabilities` | Discord permissions the bot needs for your block to work. Declared, not yet enforced. |
| `startedBy` | **Triggers only.** What fires you: `buttonClick`, `memberJoin`, or `reactionAdd`. The gateway dispatchers select on this, so a new trigger for an existing source needs no dispatcher edit. Leave it off any condition or action. |
| `canSuspend` | Whether `run` may park the run. State it truthfully; conformance holds you to it. |
| `run` | The entry point. See [The entry point](#the-entry-point). |

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
| `text` | string | one line. `maxLength`, `placeholder`. |
| `longText` | string | a message body. `maxLength`, `placeholder`. |
| `duration` | milliseconds | any span. Shows a number plus a unit, so nobody hand-computes `604800000`. Set `optional: true` when absence is meaningful — clearing it removes the key rather than writing a zero. |
| `segmented` | string | two to four choices, all visible. Needs `options`. |
| `select` | string | more choices than that, in a dropdown. Needs `options`. |
| `colour` | `#RRGGBB` | a colour. `swatches` to suggest some. |

`defaultValue` is the starting value when a node is dropped on the canvas. It is **schema
input**: if your schema also carries a `.default()` for that key, the two must be the same
value. Declaring the default in one place and not the other is the drift this contract exists
to prevent, so conformance treats disagreement — and a schema default the field forgot to
mirror — as a failure.

## Output handles

```ts
handles: [{ label: 'Next', tone: 'neutral' }]                       // one exit
handles: [                                                          // a condition
    { id: 'true',  label: 'True',  tone: 'positive' },
    { id: 'false', label: 'False', tone: 'negative' },
]
handles: [                                                          // an event wait
    { label: 'Got it', tone: 'positive' },
    { id: 'timeout', label: 'Timeout', tone: 'caution' },
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

- `member` — the member the run is about.
- `interaction` — the interaction that started it. **This one can genuinely be absent.** A run
  started by a gateway event never has one, and neither does any resumed run. Declaring it lets
  a graph that places your block where it could never be satisfied be rejected at save time,
  naming the node and the requirement, instead of quietly taking the wrong branch.

If you find yourself reading something off `context` that you did not declare, declare it.

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

Every block that ships is written against this contract — the earlier shape, with three
separate per-kind entry points, is gone. There is one way to declare a block.
