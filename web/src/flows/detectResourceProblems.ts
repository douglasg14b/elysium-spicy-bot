/**
 * Decide which chips each declared resource has earned, from the declarations alone.
 *
 * Pure: a list in, a list of chips out. No React, no fetch, no guild lookup. That is
 * not tidiness — it is what lets this module be tested against the *server's* own
 * validator (`src/features/provisioning/logic/__tests__/resourceChipAgreement.test.ts`
 * imports both and asserts they agree), and that agreement is the entire value of the
 * red tier. A chip claiming "the save will be refused" is worth something only if the
 * save really would be.
 *
 * ## Why this is a mirror rather than a call
 *
 * The web workspace cannot import from `src/`: one `import type` drags the whole bot
 * tree into `tsc -b` and breaks `pnpm build:web`. This is the same trade
 * `web/src/api/types.ts` and `web/src/flows/declaredRoleReference.ts` already took,
 * and it is paid for the same way — a test that holds the two halves equal, living on
 * the server side where importing *into* `web/` is allowed.
 *
 * The authorities being mirrored, and nothing else:
 *
 *  - `validateJourneyDeclaration` — duplicate keys, duplicate adoptions, declared-role
 *    references naming an undeclared key or a key that is not a role.
 *  - `resourceSchema` in `src/web/api/journeyRoutes.ts` — the key regex and its 1–64
 *    cap, the name's 1–100 cap.
 *  - `permissionIntentSchema` — a `roles` intent must name at least one role.
 *
 * ## What is deliberately *not* mirrored
 *
 * `validateJourneyDeclaration` also rejects an empty journey, a parent key naming
 * nothing, a non-category parent, and a role or category declaring a parent. None of
 * those are chips, because none are reachable from this panel — and that claim now
 * rests on three things rather than two:
 *
 *  - a parent cannot be **typed**: the picker offers declared categories only, and is
 *    not rendered for a role (`canHaveParent`);
 *  - a parent cannot survive a **deletion**: `removeResource` clears a dangling
 *    `parentKey`, and drops `resource:` references, when the target goes;
 *  - a parent cannot survive a **rename**: `updateResource` routes a key change through
 *    `renameResourceKeyReferences`, which carries children and role references to the
 *    new key in the same update.
 *
 * The third was missing, and this comment used to assert unreachability on the strength
 * of the second alone. It was wrong: renaming a category's key stranded its children,
 * the server refused the save, and nothing here fired — precisely because of the
 * reasoning in this paragraph. Detecting an unreachable state would be a chip that can
 * never fire, which is worse than no chip; asserting unreachability that is not true is
 * worse still. If the panel grows another path that writes a key, this is the comment
 * to come back to. See `docs/contracts/resource-chips.md`.
 *
 * Cycles are likewise absent. `orderResourcesForApply` can throw on one, but reaching
 * it needs a parent or role-reference loop the pickers cannot express.
 */

import type { PermissionIntent, ResourceDeclaration } from '../api/types';
import { parseDeclaredRoleReference } from './declaredRoleReference';
import type { ResourceChipDetail, ResourceChipId } from './resourceChips';
import { RESOURCE_CHIP_ORDER, RESOURCE_CHIPS } from './resourceChips';

/**
 * The key rule, copied from `resourceKeySchema` in `src/web/api/journeyRoutes.ts`.
 *
 * Duplicated rather than derived for the boundary reason in the header. Held equal to
 * the server's by the agreement test, which feeds the same strings through both.
 */
const RESOURCE_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `resourceKeySchema.max(64)`. */
const RESOURCE_KEY_MAX_LENGTH = 64;

/** `defaultName`'s `.max(100)`. */
const RESOURCE_NAME_MAX_LENGTH = 100;

/**
 * One chip, resolved against one resource.
 *
 * The detail is carried as data rather than as a finished string so the caller can
 * both render it and act on it — `ruleIndex` is what tells the jump control which rule
 * row to focus, and a label reading "Rule 2 names no role" has already discarded it.
 */
export interface ResourceChipInstance {
    readonly id: ResourceChipId;
    readonly detail: ResourceChipDetail;
}

/** Every chip one resource has earned, with the resource it belongs to. */
export interface ResourceChipsForResource {
    /**
     * Position in the list handed in, **not** the key.
     *
     * The key is editable and may be duplicated — which is one of the things detected
     * here — so it identifies nothing reliably. `ResourcesPanel` already patches rows
     * by position for the same reason.
     */
    readonly index: number;
    readonly chips: readonly ResourceChipInstance[];
}

/**
 * Chips for every resource, in list order.
 *
 * Takes the whole list rather than one resource because three of the detections are
 * *relational* — a duplicate key, a duplicate adoption, and a role reference naming a
 * key the flow does not declare are all questions only something holding the whole
 * list can answer. That is the same reason `validateJourneyDeclaration` takes a
 * journey rather than a resource.
 */
export function detectResourceProblems(
    resources: readonly ResourceDeclaration[]
): readonly ResourceChipsForResource[] {
    const duplicatedKeys = keysDeclaredMoreThanOnce(resources);
    const duplicatedAdoptions = adoptionsDeclaredMoreThanOnce(resources);
    const roleKeys = new Set(
        resources.filter((resource) => resource.kind === 'role').map((resource) => resource.key)
    );
    const declaredKeys = new Set(resources.map((resource) => resource.key));

    return resources.map((resource, index) => ({
        index,
        chips: sortChips(
            chipsForResource({
                resource,
                duplicatedKeys,
                duplicatedAdoptions,
                declaredKeys,
                roleKeys,
            })
        ),
    }));
}

/**
 * Whether anything in the list would be refused by the save.
 *
 * The toolbar's count turns red on this. Asked of the detected chips rather than
 * re-derived, so the button and the rows cannot disagree about whether a flow is
 * saveable — the failure mode being avoided is a green count over a modal full of red.
 */
export function hasBlockingResourceProblem(
    detected: readonly ResourceChipsForResource[]
): boolean {
    return detected.some((entry) =>
        entry.chips.some((chip) => RESOURCE_CHIPS[chip.id].tone === 'error')
    );
}

interface ChipContext {
    readonly resource: ResourceDeclaration;
    readonly duplicatedKeys: ReadonlySet<string>;
    readonly duplicatedAdoptions: ReadonlySet<string>;
    readonly declaredKeys: ReadonlySet<string>;
    readonly roleKeys: ReadonlySet<string>;
}

function chipsForResource(context: ChipContext): ResourceChipInstance[] {
    const { resource } = context;
    const chips: ResourceChipInstance[] = [];

    // --- errors: the save or the install will refuse this ------------------------

    if (context.duplicatedKeys.has(resource.key)) {
        chips.push({ id: 'duplicateKey', detail: {} });
    }

    if (resource.adoptDiscordId && context.duplicatedAdoptions.has(resource.adoptDiscordId)) {
        chips.push({ id: 'duplicateAdoption', detail: {} });
    }

    // The name is reported in preference to the key when both are wrong. One chip
    // covers both fields (see `invalidKey` in the table), and an empty name is the
    // one an operator can see is wrong without knowing the key rules.
    if (!isValidResourceName(resource.defaultName)) {
        chips.push({ id: 'invalidKey', detail: { field: 'name' } });
    } else if (!isValidResourceKey(resource.key)) {
        chips.push({ id: 'invalidKey', detail: { field: 'key' } });
    }

    for (const [ruleIndex, intent] of (resource.permissions ?? []).entries()) {
        if (ruleNamesNoRole(intent, context)) {
            chips.push({ id: 'ruleNamesNoRole', detail: { ruleIndex } });
        }
    }

    // --- warnings: this saves, and probably does not mean what you think ---------

    // `[]` and absent are different, and the difference is the whole point: absent
    // inherits, `[]` clears inheritance and grants nothing. Checked for length rather
    // than truthiness, since `[]` is truthy and is exactly the case being caught.
    if (resource.permissions?.length === 0) {
        chips.push({ id: 'nobodyCanSee', detail: {} });
    }

    const subjectRuleIndex = (resource.permissions ?? []).findIndex(
        (intent) => intent.audience === 'subject'
    );
    if (subjectRuleIndex >= 0) {
        chips.push({ id: 'perRunOnly', detail: { ruleIndex: subjectRuleIndex } });
    }

    // `applyInstallPlan` compiles overwrites only on the create path, so rules on an
    // adopted resource are stored and never applied. An empty `permissions: []` is not
    // this case — it carries no rules to be ignored, and already has its own chip.
    if (resource.adoptDiscordId && (resource.permissions?.length ?? 0) > 0) {
        chips.push({ id: 'permissionsUntouched', detail: {} });
    }

    // --- info: true, deliberate, and not the default -----------------------------

    if (resource.adoptDiscordId) {
        chips.push({ id: 'adopted', detail: {} });
    }

    const ruleCount = resource.permissions?.length ?? 0;
    const isPrivate = (resource.permissions ?? []).some(hidesFromEveryone);

    if (isPrivate) {
        chips.push({ id: 'private', detail: {} });
    } else if (ruleCount > 1) {
        // Suppressed under `private` deliberately. "Private" already tells you this
        // resource has deliberate, non-default permissions, and two chips saying
        // "there are rules here" on one row is the redundancy the governing rule's
        // clause (b) exists to stop.
        chips.push({ id: 'orderedRules', detail: { ruleCount } });
    }

    return chips;
}

/**
 * Whether an intent is the one that makes a resource private.
 *
 * `everyone` + `hidden` specifically. A `readOnly` rule for `@everyone` is not private
 * — it is the opposite, a resource everyone can see — and a `hidden` rule aimed at
 * named roles hides it from those roles rather than from the server.
 */
function hidesFromEveryone(intent: PermissionIntent): boolean {
    return intent.audience === 'everyone' && intent.access === 'hidden';
}

/**
 * Whether a rule names a role that will not resolve.
 *
 * Three ways one rule can fail, refused in two different places on the server, and all
 * three are the same mistake to the operator — the rule names no usable role:
 *
 *  - no ids at all, refused by `permissionIntentSchema` at save;
 *  - a `resource:` reference to a key the flow does not declare, refused by
 *    `validateJourneyDeclaration` at save;
 *  - a reference to a key that *is* declared but is not a role, refused by the same.
 *
 * Only `roles` intents are asked. `staff` and `subject` carry no ids by design, and
 * `everyone` needs none — `PermissionIntentEditor` strips `roleIds` when the audience
 * changes away from `roles`, so a stale list cannot linger and be judged.
 */
function ruleNamesNoRole(intent: PermissionIntent, context: ChipContext): boolean {
    if (intent.audience !== 'roles') return false;

    const roleIds = intent.roleIds ?? [];
    if (roleIds.length === 0) return true;

    return roleIds.some((roleId) => {
        const referencedKey = parseDeclaredRoleReference(roleId);
        // A plain snowflake is a real guild role. Whether it still exists is a question
        // only the guild can answer, and the server does not ask it at save time
        // either — so neither does this.
        if (referencedKey === undefined) return false;

        if (!context.declaredKeys.has(referencedKey)) return true;
        return !context.roleKeys.has(referencedKey);
    });
}

/** `resourceKeySchema`: 1–64 characters, lowercase, digits, single hyphens. */
function isValidResourceKey(key: string): boolean {
    return key.length <= RESOURCE_KEY_MAX_LENGTH && RESOURCE_KEY_PATTERN.test(key);
}

/**
 * `defaultName`: 1–100 characters.
 *
 * Only the emptiness and the cap, because that is all the server checks. Discord's own
 * channel-naming rules are not applied here: Discord silently transforms a channel
 * name it dislikes rather than refusing it, so a chip claiming the save would fail
 * would be wrong.
 */
function isValidResourceName(name: string): boolean {
    return name.length > 0 && name.length <= RESOURCE_NAME_MAX_LENGTH;
}

/**
 * Every key held by more than one resource.
 *
 * Both rows get the chip, not just the second. The server names one of them in its
 * message, but an operator looking at a list needs to see both — the fix is to change
 * one, and which one is their choice.
 */
function keysDeclaredMoreThanOnce(
    resources: readonly ResourceDeclaration[]
): ReadonlySet<string> {
    return valuesSeenMoreThanOnce(resources.map((resource) => resource.key));
}

/** Every adopted id held by more than one resource. Same reasoning as the keys. */
function adoptionsDeclaredMoreThanOnce(
    resources: readonly ResourceDeclaration[]
): ReadonlySet<string> {
    return valuesSeenMoreThanOnce(
        resources
            .map((resource) => resource.adoptDiscordId)
            .filter((id): id is string => id !== undefined)
    );
}

function valuesSeenMoreThanOnce(values: readonly string[]): ReadonlySet<string> {
    const seen = new Set<string>();
    const repeated = new Set<string>();

    for (const value of values) {
        if (seen.has(value)) repeated.add(value);
        seen.add(value);
    }

    return repeated;
}

/**
 * Put a row's chips in render order: problems first, then the merely true.
 *
 * Sorted against `RESOURCE_CHIP_ORDER` rather than left in detection order, because
 * detection order is an artefact of how this file is written and render order is a
 * decision — a row that cannot save should lead with why.
 */
function sortChips(chips: readonly ResourceChipInstance[]): readonly ResourceChipInstance[] {
    return [...chips].sort(
        (first, second) =>
            RESOURCE_CHIP_ORDER.indexOf(first.id) - RESOURCE_CHIP_ORDER.indexOf(second.id)
    );
}
