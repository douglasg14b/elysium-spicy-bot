# 5A.4 — Unpublishing resources, and undeploying flows

Everything this system creates in a guild is currently one-way. A flow can publish
channels, roles and buttons; nothing can take them back. Two independent gaps:

1. **Resources** — a journey creates a category, channel or role and there is no
   path that deletes it. Deleting the journey deliberately *keeps* the bindings.
2. **Buttons** — `deployFlowButtons` posts a message and returns its `messageId`,
   and **nothing persists it**. `DELETE /flows/:flowId` removes the row and stops,
   so the buttons stay in the channel pointing at a flow that no longer exists.

Gap 2 is a live defect in shipped behaviour, not a missing 5B feature.

## What is already in place

The teardown design was anticipated. `resource_bindings.state` is
`'intended' | 'created' | 'adopted'`, and `resourceBindingsSchema.ts:15` states the
rule this plan implements:

> `created` and `adopted` … differ only in provenance, which matters for teardown —
> 5B may delete what it created and must never delete what it adopted.

So the provenance needed to decide what may be destroyed is **already being
written on every install**. This plan consumes it; it does not add it.

Reuse, do not reinvent:
- `resourceBindingsRepo` (`listByJourney`, `get`, `discardIntent`) — `data/resourceBindingsRepo.ts`
- `existsInGuildAs(guild, kind, discordId)` — `logic/installPlan.ts:106`
- The plan → preview → apply shape of `buildInstallPlan` / `applyInstallPlan`

## Decisions already made (do not re-litigate)

| Question | Decision |
|---|---|
| Category with survivors inside | **Refuse**, name the survivors, change nothing |
| Deleting a flow | **Offer, never assume.** Delete removes the record; unpublish is a separate deliberate confirm |
| Undeploy scope | Record future deployments; delete the message on undeploy; offer it on flow delete. **No backfill** of already-deployed messages |
| Preview first | **Yes** — list every deletion and every refusal before anything happens |

---

# Part 1 — Unpublish resources

## The rule

A binding may be deleted from the guild **only** when `state === 'created'`.
`adopted` is refused, always — the operator said that channel existed first.
`intended` has no `discordId`; the row is discarded, nothing is touched.

This is not a warning the operator can click through. Adoption is the promise that
we will not touch their existing structure, and a confirmable override would make
that promise conditional.

## The cascade problem — the reason "refuse" was chosen

Discord deletes a category's children along with it. A journey can legitimately
create a category and adopt a channel inside it, so deleting the category would
destroy something the rule above forbids touching.

**Before deleting any category, list its current children in the guild.** For each
child, it is a *survivor* unless it is itself a `created` binding in this same
unpublish set. A survivor includes an adopted channel, a channel created by hand
later, and a channel belonging to a different journey.

If a category has survivors, **refuse that category**, report it by name with the
survivors named, and continue with the rest. The rest of the unpublish still
proceeds — one blocked category must not abandon the whole operation.

Read children from the guild, not from bindings. A hand-made channel has no
binding and is exactly the case that must block.

## Ordering

Reverse of install: children before parents, so a category is empty by the time it
is considered. `orderResourcesForApply` in `logic/resourceDeclaration.ts` already
does dependency ordering — reversing its output is the intended reuse, **but check
it**: it orders *declarations*, and unpublish works from *bindings*, which outlive
the declaration they came from. If a declaration is gone, order by kind
(textChannel, then role, then category) and say so in your report.

## Shape

Mirror install. Two functions, one pure:

```ts
buildUnpublishPlan(input): UnpublishPlan   // pure, no I/O — decides and explains
applyUnpublishPlan(input): Promise<...>    // performs it
```

`UnpublishPlan` holds, per binding, one of:
- `delete` — a `created` binding whose object still exists
- `forget` — the object is already gone, or state is `intended`; drop the row only
- `refuse` — with a **reason**: `adopted`, or `category-has-survivors` naming them

Every refusal carries text an operator can act on. "Cannot unpublish" with no
reason is the failure mode this preview exists to prevent.

## Apply, and the crash-safety mirror

Install records intent *before* mutating. Unpublish is the mirror: **delete the
Discord object first, then remove the binding row.** A crash in between leaves a
binding pointing at a deleted object — which the existing install path already
handles (`installPlan.test.ts:162`, *"plans a recreate when a bound resource has
been deleted from the guild"*). The opposite order would orphan a live channel
with no record that we made it, which nothing can recover.

State this ordering in a comment where it is implemented; it looks arbitrary and
is not.

Per-item failures must not abort the run — report and continue, as
`applyInstallPlan` does. A role deleted by hand mid-run is a `forget`, not an error.

## Permissions

Check `ManageChannels` / `ManageRoles` and role hierarchy **in the plan**, not at
apply. A refusal the operator can see before confirming beats a half-finished
teardown. There is preflight precedent in the install path — follow it.

---

# Part 2 — Undeploy flow buttons

## The migration

Nothing records where buttons were posted. New table `flow_deployments`:

```
id, guild_id, flow_id, channel_id, message_id, node_ids (json), created_at, updated_at
```

Dual-dialect, following `2026-09-18-Create_Resource_Bindings.ts` exactly —
`CamelCasePlugin` before `SqlDatePlugin`, sqlite timestamps via
`sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))``. Index on `(guild_id, flow_id)`.

A flow may be deployed to several channels, so this is a list, not a column on
`flows`. `deployFlowButtons` already returns `messageId` — persist what it returns
rather than changing what it does.

**Already-deployed messages predate this table and stay orphaned.** That is the
accepted consequence of skipping backfill; say so in the API response or UI copy
rather than implying undeploy found everything.

## Undeploy

Delete the recorded message, then the row. A message already deleted by hand is a
success, not an error — the desired state is "no live button", and it holds.

`DELETE /flows/:flowId` must **not** silently undeploy (decision: offer, never
assume). Instead:
- `GET /flows/:flowId/published` — what this flow has in the guild: deployments,
  and `created` bindings from its journey
- the delete dialog calls it, and if anything is published, says so and offers
  undeploy/unpublish as a **separate confirmed action**

## The dead-button defect

Independent of everything above and worth fixing in the same pass:
`flowTriggerDispatch` should answer a click on a button whose flow is gone with a
clear ephemeral message rather than whatever it currently does. **Check the current
behaviour first** — if it already handles it, say so and change nothing.

---

# UI

- **Flow builder / flows list** — a delete dialog that names what is published and
  offers cleanup as a separate confirm.
- **Unpublish** — the preview: what will be deleted, what is refused and why.
  Refusals are the point; do not bury them under a count.
- Copy stays in the product's voice. Do not sanitise it — but a confirm dialog for
  an irreversible action should be unambiguous about what it destroys. Clarity
  first, sass second.

The `web/` package has **no jsdom and no React testing library**; `vitest.config.ts`
collects `*.test.ts` only. Put the decisions in pure modules and test those. Do not
add render-test infrastructure for this.

---

# Tests

Behaviour, not plumbing (~90% budget):

- An `adopted` binding is **never** planned for deletion. *(sabotage-verify this one
  — it is the promise the whole feature rests on)*
- A category with an adopted child is refused, and the survivor is named
- A category whose children are all in the same unpublish set proceeds
- A category with a hand-made (binding-less) child is refused
- Children are ordered before parents
- A binding whose object is already gone is a `forget`, not a failure
- One item failing does not abort the rest
- Undeploy deletes the recorded message and the row
- Undeploy of an already-deleted message succeeds
- `DELETE /flows/:flowId` alone deletes nothing in the guild *(the "offer, never
  assume" decision, guarded)*

---

# Constraints

- **Dependency boundary:** `src/features/provisioning/` must never import
  `src/features/flows/`. Undeploy is flows-side; unpublish is provisioning-side. If
  they must meet, use the registered-callback seam in `resourceWriteBack.ts`.
- **Engine vocabulary gate** (`flows/__tests__/engineVocabulary.test.ts`) rejects
  `journey`, `resource`, `scope` in `flows/engine`, `flows/data`,
  `flows/constants.ts`, non-recursive `flows/blocks`. `flow_deployments` work lives
  in `flows/data` — name it in engine-neutral terms. Run that test early.
- File ops via Read/Edit/Write. **No `python3`** — it is not installed and a previous
  sabotage attempt silently no-opped into a false pass.
- Baseline: server typecheck **17** pre-existing errors, web **0**; `pnpm test`
  **1152 passing, 1 pre-existing failure** (`ciBranchProductDiff`).
- Migrations via `pnpm migrate:latest`. Deps via `pnpm add` only.

# Definition of done

- Typecheck at baseline, no new test failures, migration runs on sqlite.
- Sabotage-verify at least: the adopted-binding guard, the cascade refusal, and the
  "delete flow touches nothing in the guild" guard. Each must fail a **named** test.
- Report what the ordering reuse actually turned out to be, and anything here that
  proved wrong. The plan is a starting point, not a specification to satisfy.
