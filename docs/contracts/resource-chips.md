# Contract — Resource chips

- **Status**: Active (2026-09-20)
- **Applies to**: `web/src/flows/resourceChips.ts`, `web/src/flows/detectResourceProblems.ts`, `web/src/flows/ResourceChip.tsx`
- **Audience**: anyone changing what a resource row says about itself in the "Resources this flow needs" modal

A **chip** is a short badge on a collapsed resource row: one fact about that resource, worth
knowing without opening it. This document is the whole vocabulary — what each chip means, when
it appears, and, just as importantly, [what is deliberately not a chip](#deliberately-not-chips).

## The governing rule

A chip earns its place only if it is all three of:

1. **not the default** — it says something a normal resource would not say;
2. **not already visible structurally** — the icon, the accent colour, the indentation and the
   name have not already said it;
3. **something you would act on** — knowing it changes what you do next.

**Silence means normal.** A row with no chips is a row nobody has to think about, and that is
what makes the rows that do carry one worth reading. The modal shows fourteen resources in a
typical flow; if ten of them are quiet, scanning the list takes about two seconds.

A chip that would appear on the majority of rows fails the rule by definition, however true it
is. That test is what killed five candidates from the first design, and it is the test to apply
to a sixth.

## Two tiers

| Tier | Tone | Colour | Means |
| --- | --- | --- | --- |
| info | `info` | grey, or **teal** for adoption | True, deliberate, and not the default. Nothing is wrong. |
| problem | `warn` | amber | Saves fine, installs fine, and probably does not do what you think. |
| problem | `error` | red | The save or the install **will refuse it**. |

The line between `warn` and `error` is not a matter of degree. `error` is a claim about the
server — that `validateJourneyDeclaration` or the route's Zod schema would reject this
declaration — and it is the reason `detectResourceProblems.ts` mirrors those rules rather than
approximating them. A red chip that cries wolf costs the entire vocabulary its credibility, and
an amber chip promoted to red blocks a save the server would have honoured.

`adopted` is the single exception to tone-picks-colour: it is `info` but teal, because adoption
is the one fact that changes what install *does to the server*, and it reads as a different kind
of statement from "this is private".

## The vocabulary

| Chip id | Tone | Label | Appears when | Clicking it |
| --- | --- | --- | --- | --- |
| `duplicateKey` | error | `Duplicate key` | Two resources share a key. `validateJourneyDeclaration` rejects the save outright, and nothing warns you while typing it. **Both** rows are chipped, not just the second — the fix is to change one, and which one is your choice. | Focuses the key field. |
| `duplicateAdoption` | error | `Adopted twice` | Two resources adopt the same guild object. One guild object cannot be two resources; the same validator refuses it. | Focuses the "already exists" picker. |
| `invalidKey` | error | `Invalid key` / `Name required` | The key fails `^[a-z0-9]+(-[a-z0-9]+)*$` or its 1–64 cap, or the name is empty or over 100 characters. Zod refuses the save. One chip covers both fields because they sit together and the fix is the same shape; the wording still distinguishes them. | Focuses the offending field. |
| `ruleNamesNoRole` | error | `Rule N names no role` | A `roles` intent with an empty list (refused at save), or one naming a declared role the flow does not have — or names a key that is not a role at all (both refused at save). | Focuses that rule's role picker. |
| `nobodyCanSee` | warn | `Nobody can see this` | `permissions: []` — inheritance cleared with no rules to replace it. Produces a channel only the bot and admins can see. Almost always a mistake. | Focuses "Back to inheriting". |
| `perRunOnly` | warn | `Per-run only` | Any `subject` audience. `journeyNeedsSubject` makes the whole flow non-installable as shared server structure — a consequence that otherwise hides inside an expanded rule. | Focuses that rule. |
| `permissionsUntouched` | warn | `Permissions untouched` | Adopted **and** carrying rules. `applyInstallPlan` only compiles overwrites on the create path, so the rules are saved and never applied. | Scrolls to the rules. |
| `adopted` | info (teal) | `Adopted` | `adoptDiscordId` is set. Install binds the existing channel instead of creating one. | Focuses the "already exists" picker. |
| `private` | info | `Private` | A rule hides it from `@everyone`. The common, deliberate case, worth stating because "who can see this" is the question the modal exists to answer. | Scrolls to the rules. |
| `orderedRules` | info | `N rules in order` | Two or more rules, and none of them a simple hide. | Scrolls to the rules. |

The table is rendered in that order on a row: problems first, then what is merely true. A row
that cannot save should lead with why.

### Why `orderedRules` says "in order"

A bare count — "3 rules" — tells you how much there is to read and nothing about what it means,
which fails clause (3) of the governing rule. `compilePermissionIntents` lets a later intent
win per id, so a resource's rules are a **sequence**, not a set: "hidden from everyone, then
read-write for this role" says something its reverse does not. "In order" is the word that turns
the number into a fact you can act on. Without it, this chip would not have been admitted.

### Why `orderedRules` is suppressed under `private`

Both chips mean "there are deliberate rules here". Showing them together on one row is exactly
the redundancy clause (2) exists to stop, so `private` wins and the count is dropped.

## Every chip is a jump control

Clicking a chip expands the row and focuses the field that caused it. That is what stops these
being decoration: each chip is the shortest path to the thing it is complaining about. A chip
saying `Rule 2 names no role` that left you to find rule 2 yourself would be a worse version of
scrolling.

The table names the target (`jumpTo`); it does not implement the focusing, because only the
component rendering the expanded row owns the refs. Chips carrying a detail — a rule index, a
count, which field failed — carry it as **data** rather than as a pre-formatted string, for the
same reason: `ruleIndex` is what tells the jump control which row to focus, and a label reading
"Rule 2 names no role" has already thrown it away.

<a id="deliberately-not-chips"></a>

## Deliberately not chips

This is the most valuable section of the document, because it is the reasoning that will
otherwise be re-litigated by everyone who looks at the modal and thinks of an obvious addition.

| Rejected | Why |
| --- | --- |
| `Creates new` | It is the default. Every resource that is not adopted is created, so this would appear on most rows. |
| `Inherits` | The default for anything inside a category. Same failure, same reason. |
| `in <category>` | Already said by the row's indentation — clause (2). |
| `N channels inside` | Countable by looking at the rows underneath it. |
| `Channel` / `Category` / `Role` | Already said by the kind icon and the accent colour, which `RESOURCE_KIND_STYLES` exists to make distinct. A grey badge reading "Role" carries less than an orange shield does. |

All five were in the first design. Each would have appeared on the **majority of rows**, which
is the definition of a chip carrying no information — and a vocabulary where most rows are noisy
is one nobody reads, which costs the four rows that actually needed attention.

Two further things are **not** detected, and their absence is deliberate rather than an
oversight:

- **A dangling `parentKey`, a non-category parent, a role or category declaring a parent.**
  `validateJourneyDeclaration` rejects all of these, but none is reachable from this panel,
  because **all three ways of creating one are closed**:

  1. it cannot be *typed* — the parent picker offers declared categories and nothing else, and
     is not rendered for a role at all (`canHaveParent`);
  2. it cannot survive a *deletion* — `removeResource` clears a child's `parentKey` when its
     category goes, and drops `resource:` references when a role goes;
  3. it cannot survive a *rename* — `updateResource` routes a key change through
     `renameResourceKeyReferences`, which rewrites every child's `parentKey` and every
     `resource:<key>` role reference to the new key in the same update.

  **Point 3 was missing, and this paragraph used to claim the case was unreachable on the
  strength of point 2 alone.** It was not. Renaming a category's key left its children pointing
  at a key nothing declared; the save was refused by the server, and no chip fired, because the
  detector does not check `parentKey` — precisely on the grounds asserted here. The fix is in
  `updateResource` rather than in the detector on purpose: a chip would have reported a broken
  state that the UI itself created one keystroke earlier, and rewriting the references means the
  state never exists. `resourceRows.test.ts` holds it, asserting that
  `danglingParentKeys` and `danglingRoleReferences` are both empty after a rename.

  A chip that can never fire is worse than no chip — it is code claiming to guard something. If
  the panel ever lets a parent be typed, or grows another path that writes a key, this is the
  paragraph to come back to, and the list above is the one to extend.
- **Whether an adopted id or a plain role snowflake still exists in the guild.** The server does
  not check this at save time either, and for a good reason: a channel can be deleted between
  declaring it and installing, so a save-time guarantee would expire. It is asked at plan time
  and again at apply time, where the answer is still true.

## Adding a chip

1. Add the id to `ResourceChipId` and a row to `RESOURCE_CHIPS` in
   `web/src/flows/resourceChips.ts` — tone, colour, icon, label builder, `reason`, `jumpTo`.
   The `reason` is the sentence shown in the chip's tooltip, so write it as one.
2. Add it to `RESOURCE_CHIP_ORDER`, which decides render order.
3. Detect it in `web/src/flows/detectResourceProblems.ts`. If it carries a detail, extend
   `ResourceChipDetail` rather than formatting a string early.
4. Add a row to the [vocabulary table](#the-vocabulary) above. `resourceChipsDocSync.test.ts`
   fails by name if you forget, in either direction.
5. If the chip is `error`, add a case to `REJECTED` in
   `src/features/provisioning/logic/__tests__/resourceChipAgreement.test.ts`. A red chip with no
   agreement case is a claim about the server that nothing has checked.

Before any of that, apply the governing rule honestly: **would this chip appear on most rows?**
If so, it is not a chip, whatever else is true of it.

## How the red tier stays honest

`detectResourceProblems.ts` re-implements the server's rules because it cannot call them — one
`import type` from `src/` inside `web/` drags the bot tree into `tsc -b` and breaks
`pnpm build:web`. This is the same trade `web/src/api/types.ts` and
`web/src/flows/declaredRoleReference.ts` already took, and it is paid the same way: a test holds
the two halves equal instead of the compiler.

`src/features/provisioning/logic/__tests__/resourceChipAgreement.test.ts` drives both the Zod
schema and `validateJourneyDeclaration` with the same declarations the browser judges, and
asserts agreement **in both directions**:

- a declaration the detector calls an error must really be rejected — otherwise a red chip
  blocks a save that would have worked;
- a declaration the detector leaves clean must really be accepted — otherwise the save fails
  with a server banner over a modal showing no problems at all, which is the state this whole
  vocabulary exists to prevent.

It lives under `src/` because imports run that way across the boundary; the reverse is what
breaks the build. `nodeDescriptorDrift.test.ts` and `declaredRoleReference.test.ts` are the same
arrangement.
