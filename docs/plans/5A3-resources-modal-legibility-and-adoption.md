# 5A.3 — Resources modal: legibility, and adopting channels that already exist

Operator feedback, verbatim in substance:

> The modal is a little small, and the text and input boxes for things like the
> channel name, the key, and the role … are a little bit too small. It's hard to read.

> When selecting resources, that should be an autocomplete sort of box where we
> can start typing and we get channels that already exist in there. Maybe I want
> to declare certain resources are required, and maybe one of those resources
> already exists, which is fine, but I can't seem to select pre-existing resources.

Scope is `web/src/flows/ResourcesPanel.tsx` (463 lines), its supporting
`resourceMeta.ts`, `PermissionIntentEditor.tsx`, and the modal's invocation in
`web/src/pages/FlowBuilderPage.tsx` around line 968.

## Part A — legibility

Everything in the panel is `size="xs"` with `12px`/`12.5px` text
(`ResourcesPanel.tsx:170,190,223-264,369-380`). That is the density of a
sidebar, and the panel is no longer in a sidebar — it moved to a modal and
kept its cramped sizing.

- Modal `size="xl"` → wider. Use a generous explicit width (e.g. `size="1100px"`)
  and give it height so rows are not in a tiny scroll well.
- Inputs `size="xs"` → `size="sm"` at minimum. Labels and values at default body
  size, not `12px`.
- Give the row a real layout. Key, name, and kind currently compete for a narrow
  strip; with the extra width, let each field breathe and label it clearly.
- Keep the kind badge/icon system from `resourceMeta.ts` — that landed well and
  the operator did not complain about it. Do **not** redesign it.

Judgement call is yours on exact values; the test is "legible on a normal
monitor without leaning in." Do not shrink anything.

## Part B — adopt a channel that already exists

The real gap. `ResourcesPanel` takes `roles` but **not** `channels**
(`ResourcesPanel.tsx:38-45`), so an operator can only ever declare a *new*
channel. Reality is often "this flow needs #announcements, which we already have."

### The model question, and the answer

Do **not** invent a second resource kind. A resource is still `{key, kind,
defaultName, ...}`; adopting is a fact about *how it resolves at install*, not a
different sort of thing.

The existing install path already distinguishes create-vs-adopt — see
`ResourceChoice` and `PlanAction` in
`src/features/provisioning/logic/installPlan.ts`. **Read that first.** If the
plan already supports an operator choosing an existing channel at install time,
the right change may be purely in the panel: let the operator *pre-seed* that
choice when declaring, rather than adding a new concept.

Check `resource_bindings` and `applyInstallPlan` before designing. If adoption
is already modelled, wire to it. If it genuinely is not, add the smallest field
that expresses "prefer this existing id" — and say plainly in your report that
you added a field and why the existing model could not carry it.

**Server-side validation must follow.** `resourceSchema` in
`src/web/api/journeyRoutes.ts:80-90` is the gate; a new field that the server
drops on the floor is worse than no field. Extend the Zod schema and
`validateJourneyDeclaration` in
`src/features/provisioning/logic/resourceDeclaration.ts` together.

### The control

An `Autocomplete`/`Select` that is `searchable` and lists real guild channels,
alongside "create a new one". `FlowBuilderPage` already loads channels for the
pickers — thread the same list down rather than fetching twice.

Selecting an existing channel should sensibly default the `defaultName` and
`key` (a slug of the channel name) so the operator is not made to type what the
UI already knows — while leaving both editable, because the key is identity and
they may want their own.

### Traps

- **Do not** break the key-editing fix: rows are patched by *index*, not by
  `resource.key`, because the key is editable and matching on it remounts the
  input mid-keystroke. Preserve that.
- A category must not be offered as its own parent. Already handled; keep it.
- Declared-role references in permissions use the `resource:` prefix
  (`DECLARED_ROLE_PREFIX`). Do not hand-spell it.

## Tests

- Panel renders an existing channel in its options when `channels` is non-empty.
- Choosing an existing channel produces the declaration shape the server accepts.
- Server rejects a malformed version of whatever field you add.
- Index-based row patching still holds when the key is edited (regression guard).

## Out of scope

Save-time validation errors, node error highlighting, sidebar resizing. Another
agent owns `nodeDataValidation.ts`, `flowRoutes.ts`, `NodeInspector.tsx`,
`FlowNodeCard.tsx`, and the controls directory. Do not touch them.

`FlowBuilderPage.tsx` is shared — confine your edits to the Resources modal
invocation and the channels prop.

## Definition of done

- `pnpm typecheck` clean in `web/`; no new server errors over the 17 baseline.
- `pnpm test` — no new failures.
- Sabotage-verify any new server-side guard.
- Report what you changed in the data model, if anything, and why.
