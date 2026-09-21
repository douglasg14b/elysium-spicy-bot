/**
 * Turning a flat list of declarations into the rows the modal draws, and keeping
 * references intact when a key changes.
 *
 * Everything here is a decision rather than a rendering, which is the whole reason the
 * module exists. `web/` has no jsdom, so a component is not something the suite can
 * drive; the arrangement this repo already uses (`installSummary.ts`, `cardSummary.ts`,
 * `resourceAdoption.ts`) is to keep the answers in a plain module and leave the
 * component a renderer over them. Sort order, indentation, what a filter matches, and
 * what a rename has to rewrite are all things that can be *wrong*, so they live where
 * `resourceRows.test.ts` can ask.
 *
 * The panel still owns the refs, the expansion state and the focus calls. Those are
 * genuinely untestable without a DOM, and separating them is what keeps the untestable
 * part small enough to read.
 */

import type { PermissionIntent, ResourceDeclaration } from '../api/types';
import { declaredRoleOptionValue, parseDeclaredRoleReference } from './declaredRoleReference';

/**
 * One row as the list renders it: the declaration, where it sits, and how deep.
 *
 * `index` is the position in the **original** list, carried rather than recomputed,
 * because it is the identity everything else in this feature already uses —
 * `detectResourceProblems` keys its chips by it, and `ResourcesPanel` patches by it.
 * Sorting and filtering both reorder and remove rows, so a row's position in *this*
 * array is not its position in the list being edited; conflating the two would patch
 * the wrong resource the moment a filter was typed.
 */
export interface ResourceRowEntry {
    readonly resource: ResourceDeclaration;
    /** Position in the list handed in — the key for chips and for patches. */
    readonly index: number;
    /**
     * Indentation depth. `0` for a category, a role, or a top-level channel; `1` for a
     * channel shown under its category.
     *
     * A number rather than a boolean because it is multiplied by the indent width, and
     * because `canHaveParent` limiting nesting to one level today is a property of the
     * *server's* model rather than of this list — `validateJourneyDeclaration` rejects a
     * category with a parent, so depth cannot currently exceed 1. If that ever changes,
     * this is already the right shape and the sort is the only thing to revisit.
     */
    readonly depth: number;
    /**
     * Shown only to give a matching child somewhere to hang, not because it matched.
     *
     * Dimmed by the renderer. See `filterResourceRows` for why a hidden parent was
     * rejected in favour of this.
     */
    readonly isFilterContext: boolean;
}

/**
 * Order the rows so every category is immediately followed by its own channels.
 *
 * **The sort is a grouping, not a comparison.** A comparator over the flat list cannot
 * express "children follow their parent" without inventing a sort key that encodes the
 * parent — and that key would have to be rebuilt on every rename. Walking the
 * categories and pulling each one's children is the same answer with nothing to keep in
 * sync.
 *
 * Declaration order is preserved *within* each group rather than sorting by name. The
 * list is the operator's own, they added things in an order that meant something to
 * them, and a list that reshuffles itself when a resource is renamed is one where the
 * row you were about to click moves out from under the cursor. Alphabetical sorting was
 * the rejected alternative for exactly that reason.
 *
 * Three groups, in this order, matching the mockup:
 *
 *  1. each category, followed by the channels parented to it;
 *  2. channels with no parent, or whose parent does not exist;
 *  3. roles, which are neither containers nor contained.
 *
 * An orphan — a channel whose `parentKey` names nothing — lands in group 2 rather than
 * vanishing. It is exactly the state item 7's rename fix exists to prevent, and a row
 * the operator cannot see is a row they cannot repair.
 */
export function orderResourceRows(
    resources: readonly ResourceDeclaration[]
): readonly ResourceRowEntry[] {
    const entries = resources.map((resource, index) => ({ resource, index }));

    const categories = entries.filter(({ resource }) => resource.kind === 'category');
    const roles = entries.filter(({ resource }) => resource.kind === 'role');

    const channels = entries.filter(
        ({ resource }) => resource.kind !== 'category' && resource.kind !== 'role'
    );

    const rows: ResourceRowEntry[] = [];
    /**
     * Which channels a category has already claimed.
     *
     * Needed because two categories can hold the **same key** — briefly, while the
     * operator is fixing the duplicate the red `duplicateKey` chip is complaining
     * about. Without this, a child matching that key is emitted under both of them, and
     * since the panel renders with `key={row.index}` and keys both the expanded-row set
     * and the chip map by the same index, the duplicate collides on all three: React
     * reconciles two siblings with one key, and expanding one row expands the other.
     * The list has to stay well-behaved exactly when it is being repaired.
     */
    const placed = new Set<number>();

    for (const category of categories) {
        rows.push({ ...category, depth: 0, isFilterContext: false });

        for (const channel of channels) {
            if (channel.resource.parentKey === category.resource.key && !placed.has(channel.index)) {
                placed.add(channel.index);
                rows.push({ ...channel, depth: 1, isFilterContext: false });
            }
        }
    }

    for (const channel of channels) {
        // Anything no category claimed: no parent at all, or a parent that is not a
        // declared category. The second is the dangling reference the rename fix closes
        // off; showing it top-level is how an operator gets at it if one ever survives.
        if (!placed.has(channel.index)) {
            rows.push({ ...channel, depth: 0, isFilterContext: false });
        }
    }

    for (const role of roles) {
        rows.push({ ...role, depth: 0, isFilterContext: false });
    }

    return rows;
}

/**
 * Whether one resource matches what was typed in the filter box.
 *
 * Name and key, case-insensitively, on a trimmed query. Substring rather than prefix
 * because operators think in fragments of a name — typing `vet` to find `#vetting` is
 * the actual use — and fuzzy matching was rejected as a thing that cannot be predicted
 * from looking at it, which for a box whose whole job is *narrowing* is worse than
 * being slightly too literal.
 *
 * The key is matched as well as the name because the key is what error chips complain
 * about: `Duplicate key` sends you looking for a key, and a filter that only knew names
 * could not find it.
 */
export function resourceMatchesFilter(resource: ResourceDeclaration, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    return (
        resource.defaultName.toLowerCase().includes(needle) ||
        resource.key.toLowerCase().includes(needle)
    );
}

/**
 * Narrow the rows to those matching the filter, keeping matched children legible.
 *
 * **The judgement call, and the alternative rejected.** When a child matches but its
 * category does not, the category is kept as a dimmed *context* row rather than either
 * (a) hidden, leaving the child indented under nothing, or (b) flattened, which drops
 * the indentation that the chip vocabulary explicitly relies on — `in <category>` was
 * rejected as a chip *because* the indentation already says it
 * (`docs/contracts/resource-chips.md`). Flattening while filtering would quietly delete
 * that fact exactly when the operator is hunting for one row and most needs to know
 * where it lives.
 *
 * A context row is marked rather than merely rendered, because the renderer has to show
 * it as scenery: it is not a search result, and styling it like one would claim the
 * category matched when it did not.
 *
 * A category that matches on its own name is a normal result and brings its children
 * with it — searching for a category means wanting to see what is inside it.
 */
export function filterResourceRows(
    rows: readonly ResourceRowEntry[],
    query: string
): readonly ResourceRowEntry[] {
    if (!query.trim()) return rows;

    const matched = new Set(
        rows
            .filter((row) => resourceMatchesFilter(row.resource, query))
            .map((row) => row.index)
    );

    // A matching category shows everything inside it; the child does not have to match
    // too. Collected first so the pass below can treat them as matches.
    const parentKeysOfMatches = new Set(
        rows
            .filter((row) => matched.has(row.index) && row.resource.kind === 'category')
            .map((row) => row.resource.key)
    );

    const visible = rows.filter(
        (row) =>
            matched.has(row.index) ||
            (row.depth > 0 && row.resource.parentKey !== undefined &&
                parentKeysOfMatches.has(row.resource.parentKey))
    );

    const visibleIndexes = new Set(visible.map((row) => row.index));

    // Any category owed to a visible child, that is not already visible itself.
    const contextKeys = new Set(
        visible
            .filter((row) => row.depth > 0)
            .flatMap((row) => row.resource.parentKey ?? [])
    );

    return rows
        .filter(
            (row) =>
                visibleIndexes.has(row.index) ||
                (row.resource.kind === 'category' && contextKeys.has(row.resource.key))
        )
        .map((row) =>
            visibleIndexes.has(row.index) ? row : { ...row, isFilterContext: true }
        );
}

/**
 * Rewrite every reference to a resource key that is about to change.
 *
 * **The bug this closes.** `removeResource` clears a child's `parentKey` when its
 * category is deleted, and drops `resource:` references when a role is deleted — but
 * nothing did the equivalent when a key was *renamed*. Children kept pointing at the
 * old key, `validateJourneyDeclaration` refused the save, and no chip fired, because
 * `detectResourceProblems` deliberately does not check `parentKey` (it was documented
 * as unreachable, which was true for deletion and false for renaming). The operator got
 * a server banner naming a key they had just stopped using.
 *
 * Fixed here — at the point the key changes — rather than by teaching the detector to
 * spot the wreckage afterwards. A chip would have reported a broken state that the UI
 * itself created one keystroke earlier; rewriting the references means the state is
 * never broken, which is the difference between a guard and a fix.
 *
 * Both reference kinds move together because they are the same fact: a key is the only
 * name a resource has inside a declaration, and inside the declaration list it is
 * spelled two ways — bare in `parentKey`, prefixed in `roleIds`.
 * `declaredRoleReference.ts` owns the prefix, so this asks it rather than
 * concatenating `'resource:'` itself.
 *
 * **Known gap, deliberately not closed here.** A key has a *third* reference site that
 * this function cannot reach: node configs hold `<field>Key` sidecars
 * (`resourceKeyFieldFor` in `controls/types.ts`, e.g. `roleIdKey`), and
 * `pendingResourceFields.ts` on the server refuses a graph whose sidecar names an
 * undeclared key. Renaming a role still leaves those sidecars pointing at the old key.
 *
 * **It is not the silent failure the `parentKey` bug was**, and the difference is why
 * this is a documented gap rather than a defect: `pendingResourceFields` refuses the
 * save *per node and per field*, naming the stale key and saying to declare it or pick
 * something else, and `validationIssues.ts` puts that message on the offending control.
 * The operator is told exactly what is wrong and where. Closing the gap would upgrade a
 * blocked save into a rename that just works — worth doing, but it is not rescuing
 * anyone from silent corruption.
 *
 * It is not fixed here because the rewrite has to happen against the **graph**, and
 * `ResourcesPanel` is handed the declaration list only — it receives no nodes and no
 * setter for them. Closing it means surfacing the rename to `FlowBuilderPage`, which
 * owns both halves. This comment exists so the next reader does not conclude from the
 * two cases above that all sites are covered.
 *
 * Renaming to a key another resource already holds is **not** prevented here. That is a
 * real duplicate, `duplicateKey` already says so in red, and silently refusing a
 * keystroke would be a worse answer than a chip explaining the problem.
 */
export function renameResourceKeyReferences(
    resources: readonly ResourceDeclaration[],
    previousKey: string,
    nextKey: string
): ResourceDeclaration[] {
    // A no-op rename would otherwise rewrite every reference to the same value and
    // hand back a new array, remounting rows for nothing.
    //
    // **The empty string is renamed through, not skipped.** Select-all + Delete then
    // retype is the ordinary way to change a key, and it arrives here as two patches
    // with `''` in between. Refusing to follow the children into `''` was the obvious
    // guard and is the wrong one: the second patch then renames *from* `''`, matches
    // nothing, and strands them permanently — the failure the guard was meant to
    // prevent, one keystroke later. Following both hops keeps children attached the
    // whole way, and the resource carries an `Invalid key` chip while it is empty,
    // which is the honest report of a mid-edit state.
    if (previousKey === nextKey) return [...resources];

    // **A key only identifies a resource while it is unique.** Two resources can hold
    // the same key mid-edit — most easily `''`, since clearing one key and then another
    // before retyping either is an ordinary thing to do. Matching references by value
    // alone would then carry the *other* resource's children and role references across
    // too: retyping the first `''` silently adopts the second's channels and repoints
    // its permission rules, and the result passes every check we have, because the key
    // it now names genuinely exists.
    //
    // Rewriting nothing restores the honest failure instead. The references dangle, the
    // server refuses the save, and `duplicateKey`/`invalidKey` already say why in red —
    // which is the outcome this whole rename fix exists to produce. A silently
    // mis-parented channel or a rule pointing at the wrong role is far worse than a
    // blocked save: on this product a permission rule is who can see what.
    //
    // Counted from the list rather than taken as a `renamedIndex` parameter on purpose:
    // an index is a second way of saying which resource is being renamed, and a caller
    // that passes a stale one gets silent corruption back. Asking the list how many
    // resources hold the key cannot be called wrong.
    const holders = resources.filter((resource) => resource.key === previousKey).length;
    if (holders > 1) return [...resources];

    const previousReference = declaredRoleOptionValue(previousKey);

    return resources.map((resource) => {
        let next = resource;

        if (next.parentKey === previousKey) {
            next = { ...next, parentKey: nextKey };
        }

        if (next.permissions) {
            const permissions = retargetRoleReferences(
                next.permissions,
                previousReference,
                nextKey
            );
            if (permissions !== next.permissions) {
                next = { ...next, permissions };
            }
        }

        return next;
    });
}

/**
 * Point every `resource:<old>` role reference at `<new>`.
 *
 * Returns the original array when nothing matched, so the caller can tell "unchanged"
 * from "rebuilt" by identity and avoid copying resources that had no reference at all.
 * Cheap, and it keeps React from seeing a new object for every row on every keystroke.
 *
 * A rule that ends up naming the new key twice is left alone rather than de-duplicated:
 * it cannot arise from a rename (the old and new keys are different strings, and a rule
 * naming both would have had to name the new one already), and `MultiSelect` cannot
 * produce one either.
 */
function retargetRoleReferences(
    permissions: PermissionIntent[],
    previousReference: string,
    nextKey: string
): PermissionIntent[] {
    let changed = false;

    const next = permissions.map((intent) => {
        if (intent.audience !== 'roles' || !intent.roleIds) return intent;
        if (!intent.roleIds.includes(previousReference)) return intent;

        changed = true;
        return {
            ...intent,
            roleIds: intent.roleIds.map((roleId) =>
                roleId === previousReference ? declaredRoleOptionValue(nextKey) : roleId
            ),
        };
    });

    return changed ? next : permissions;
}

/**
 * Apply one patch to one resource, rewriting anything that named its old key.
 *
 * Extracted from the panel so the two behaviours that can silently corrupt a
 * declaration are testable without a DOM:
 *
 *  - **a key change is not a change to one resource.** Children name their category by
 *    key and permissions name a declared role by key, so a rename has to carry them
 *    with it or the save is refused. See `renameResourceKeyReferences`.
 *  - **an explicit `undefined` in a patch means *remove the key*.** Spreading alone
 *    leaves it present holding `undefined`, which `JSON.stringify` drops on the way
 *    out — so the in-memory list and the saved one would disagree about whether a
 *    resource inherits its permissions. That difference is load-bearing: absent means
 *    "inherit from the category", `[]` means "inherit nothing".
 *
 * Patched by **position**, not by key. The key is itself editable, so matching on it
 * would break the moment an operator typed into the key field: the first keystroke
 * changes the value being matched against, and every later one would find no row.
 */
export function applyResourcePatch(
    resources: readonly ResourceDeclaration[],
    index: number,
    patch: Partial<ResourceDeclaration>
): ResourceDeclaration[] {
    const target = resources[index];
    if (!target) return [...resources];

    // Only a *changed* key is a rename. `patch.key === undefined` is not one — it is
    // either absent from the patch or an explicit deletion, and neither renames
    // anything, so the reference rewrite must not run.
    const renamedTo = patch.key !== undefined && patch.key !== target.key ? patch.key : undefined;

    const base =
        renamedTo === undefined
            ? resources
            : renameResourceKeyReferences(resources, target.key, renamedTo);

    return base.map((resource, position) => {
        if (position !== index) return resource;

        const next = { ...resource, ...patch };
        for (const [patchKey, value] of Object.entries(patch)) {
            if (value === undefined) {
                delete next[patchKey as keyof ResourceDeclaration];
            }
        }
        return next;
    });
}

/**
 * Remove one resource and clear every reference that named it.
 *
 * The mirror of `applyResourcePatch`'s rename, and here for the same reason: this is
 * the *other* half of one rule — **no declaration may reference a key nothing
 * declares** — and that rule was previously enforced from two places by two mechanisms,
 * one tested and one only reachable by rendering the panel. That split is how the
 * rename bug happened in the first place: deletion was handled, renaming was not, and
 * nothing held the two answers together. A third key-writing path should find both
 * halves in one module.
 *
 * A rule left naming nothing is removed rather than kept as an empty `roles` intent:
 * the server rejects `roles` with no ids, so keeping it would make the whole list
 * unsaveable in order to clear a role the operator just deleted.
 */
export function removeResourceAtIndex(
    resources: readonly ResourceDeclaration[],
    index: number
): ResourceDeclaration[] {
    const removed = resources[index];
    if (!removed) return [...resources];

    return resources
        .filter((_resource, position) => position !== index)
        .map((resource) => {
            let next = resource;

            // Anything parented to the removed category would name a parent that no
            // longer exists, which the server rejects as an invalid declaration.
            // Clearing it here keeps the list saveable, visibly.
            if (next.parentKey === removed.key) {
                const { parentKey: _dropped, ...withoutParent } = next;
                next = withoutParent;
            }

            // Same problem one level down: a permission naming the removed *role* by
            // key is a reference the journey no longer declares, which
            // `validateJourneyDeclaration` refuses. Dropping the reference keeps the
            // save working; the rule stays, minus the dead role.
            if (removed.kind === 'role' && next.permissions) {
                next = { ...next, permissions: withoutRoleKey(next.permissions, removed.key) };
            }

            return next;
        });
}

/** Drop every reference to one declared role from a set of intents. */
function withoutRoleKey(
    permissions: readonly PermissionIntent[],
    removedKey: string
): PermissionIntent[] {
    const reference = declaredRoleOptionValue(removedKey);

    return permissions.flatMap((intent) => {
        if (intent.audience !== 'roles' || !intent.roleIds) return [intent];

        const roleIds = intent.roleIds.filter((roleId) => roleId !== reference);
        if (roleIds.length === intent.roleIds.length) return [intent];
        return roleIds.length > 0 ? [{ ...intent, roleIds }] : [];
    });
}

/**
 * Whether a role reference points at a key no resource declares.
 *
 * Not used by the panel — exported for the rename tests, which assert the *absence* of
 * dangling references after a rename rather than merely asserting the new key appears
 * somewhere. Checking the thing the server would reject is what makes the test about
 * the bug instead of about the implementation.
 */
export function danglingRoleReferences(
    resources: readonly ResourceDeclaration[]
): readonly string[] {
    const declaredKeys = new Set(resources.map((resource) => resource.key));

    return resources.flatMap((resource) =>
        (resource.permissions ?? []).flatMap((intent) =>
            (intent.roleIds ?? []).flatMap((roleId) => {
                const referencedKey = parseDeclaredRoleReference(roleId);
                if (referencedKey === undefined) return [];
                return declaredKeys.has(referencedKey) ? [] : [referencedKey];
            })
        )
    );
}

/**
 * Whether a `parentKey` names something that is not a declared category.
 *
 * Same purpose as `danglingRoleReferences`: the rename tests assert this stays empty,
 * which is the condition `validateJourneyDeclaration` actually enforces.
 */
export function danglingParentKeys(
    resources: readonly ResourceDeclaration[]
): readonly string[] {
    const categoryKeys = new Set(
        resources
            .filter((resource) => resource.kind === 'category')
            .map((resource) => resource.key)
    );

    // `!== undefined` rather than truthiness: `parentKey: ''` is a *dangling* reference,
    // not an absent one, and the server refuses it. Truthiness would read the empty
    // string as "no parent" and report the list clean — a check blind to one of the
    // states it exists to catch.
    return resources.flatMap((resource) =>
        resource.parentKey !== undefined && !categoryKeys.has(resource.parentKey)
            ? [resource.parentKey]
            : []
    );
}
