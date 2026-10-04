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
 * ## Where each rule comes from
 *
 * The key and name rules are the server's own, as the SDK generates them from the route's
 * `ResourceDeclaration` schema (`zResourceDeclaration`), and the `invalidKey` chip carries
 * the server's own sentence for whichever one failed. Nothing here restates them.
 *
 * The rest are rules no schema states, so they cannot travel and are mirrored here
 * instead. The web workspace cannot import from `src/`: one `import type` drags the whole
 * bot tree into `tsc -b` and breaks `pnpm build:web`. This is the same trade
 * `web/src/flows/declaredRoleReference.ts` takes, and it is paid for the same way — a test
 * that holds the two halves equal, living on the server side where importing *into*
 * `web/` is allowed. The authorities being mirrored, and nothing else:
 *
 *  - `validateJourneyDeclaration` — duplicate keys, duplicate adoptions, declared-role
 *    references naming an undeclared key or a key that is not a role.
 *  - `rolesWithoutIdsRefusal` in `src/web/api/journeyBody.ts` — a `roles` intent must
 *    name at least one role.
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

import {
    zResourceDeclaration,
    type GuildChannel,
    type GuildRole,
    type PermissionIntent,
    type ResourceDeclaration,
} from '@brattybot/web-sdk';
import { fieldProblems } from '../api/fieldProblems';
import { parseDeclaredRoleReference } from './declaredRoleReference';
import type { ResourceChipDetail, ResourceChipId } from './resourceChips';
import { RESOURCE_CHIP_ORDER, RESOURCE_CHIPS } from './resourceChips';
import { collidableNamesFor, nameCollidesWithExisting } from './resourceNameSuggestions';

/** Shared so an absent `installedKeys` does not allocate a set per resource per render. */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

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
    resources: readonly ResourceDeclaration[],
    /**
     * What the guild already contains, when the caller knows.
     *
     * **Optional on purpose, and the optionality is the contract.** Every other
     * detection here answers a question about the *declaration* — something the server's
     * save gate can also answer, which is what `resourceChipAgreement.test.ts` holds
     * this file to. `nameTaken` is the one detection about the *guild*, which the save
     * gate cannot see and which the agreement test therefore must be able to exclude by
     * simply not passing it.
     *
     * Absent means "we could not find out", and the honest response to that is silence
     * rather than a guess: a row is not flagged for colliding with a directory nobody
     * loaded. The panel always has the directory; the agreement test never does.
     */
    guild?: GuildContext
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
                guild,
                installedKeys: guild?.installedKeys ?? EMPTY_KEYS,
            })
        ),
    }));
}

/** The guild directory, for the one detection that is about the server rather than the declaration. */
export interface GuildContext {
    readonly channels: readonly GuildChannel[];
    readonly roles: readonly GuildRole[];
    /**
     * Resource keys this journey has already installed.
     *
     * Part of the guild context rather than a separate argument because it answers the
     * same question the directory does — *what is already out there* — and because
     * `nameTaken` is unsound without it. `installPlan` never name-checks a key holding a
     * settled binding, so an installed row must not be told its name is taken by the
     * very object it installed.
     *
     * Optional, and absent means "none known". The panel supplies it; the cross-boundary
     * agreement test supplies neither this nor the directory.
     */
    readonly installedKeys?: ReadonlySet<string>;
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
    readonly guild: GuildContext | undefined;
    readonly installedKeys: ReadonlySet<string>;
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
    // one an operator can see is wrong without knowing the key rules. Either way the
    // chip carries the server's own sentence for what is wrong.
    const nameProblem = resourceNameProblem(resource.defaultName);
    const keyProblem = resourceKeyProblem(resource.key);
    if (nameProblem) {
        chips.push({ id: 'invalidKey', detail: { field: 'name', problem: nameProblem } });
    } else if (keyProblem) {
        chips.push({ id: 'invalidKey', detail: { field: 'key', problem: keyProblem } });
    }

    for (const [ruleIndex, intent] of (resource.permissions ?? []).entries()) {
        if (ruleNamesNoRole(intent, context)) {
            chips.push({ id: 'ruleNamesNoRole', detail: { ruleIndex } });
        }
    }

    // --- install blockers: the save takes this, the install will not -------------

    /*
     * The one detection about the *guild* rather than the declaration.
     *
     * `installPlan` blocks an item whose declared name matches an existing object when
     * nothing is adopted, and the operator used to meet that refusal after authoring a
     * whole journey and pressing install. Raising it on the row that caused it is the
     * whole point — and it is checked only when the caller supplied a directory, since
     * "we could not find out" must read as silence rather than as a clean bill.
     *
     * Three suppressions, and the third is the one that matters:
     *
     *  - **An invalid name.** `invalidKey` already has the row, and an empty name cannot
     *    collide with anything. Two chips for one empty box would be the row complaining
     *    twice about one keystroke.
     *  - **An adopted row**, handled inside `nameCollidesWithExisting`: matching the name
     *    of the thing you are adopting is the point, not a problem.
     *  - **An installed key.** `installPlan` short-circuits on a settled binding at
     *    `action: 'reuse'` and **never reaches `findByName`** — so for an installed
     *    resource the install raises nothing and this chip would be claiming otherwise.
     *
     * That third case is not a corner. A journey that has been installed has a binding
     * for *every* resource and a live object in the guild carrying *every* declared
     * name, so without it the chip fires on every row of a perfectly healthy journey —
     * which is both wrong and the fastest way to teach an operator that the amber chips
     * are noise. It was found on the first live look, having been predicted in review and
     * shipped anyway on the grounds that over-warning degrades safely. It does not: a
     * warning that is always on is indistinguishable from a broken one.
     */
    if (
        context.guild &&
        !nameProblem &&
        !context.installedKeys.has(resource.key)
    ) {
        const collides = nameCollidesWithExisting({
            declaredName: resource.defaultName,
            adoptDiscordId: resource.adoptDiscordId,
            guildNames: collidableNamesFor({
                kind: resource.kind,
                channels: context.guild.channels,
                roles: context.guild.roles,
            }),
        });

        if (collides) chips.push({ id: 'nameTaken', detail: {} });
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
 *  - no ids at all, refused by the save route (`rolesWithoutIdsRefusal`);
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

/**
 * The server's own sentence for what is wrong with a key, by its key rule as generated
 * into the SDK; `undefined` when the key is fine.
 *
 * Read from `fieldProblems` under `''`, its key for a problem with no field to sit under
 * — which, for a rule checking one bare value, is every problem it has.
 */
function resourceKeyProblem(key: string): string | undefined {
    return fieldProblems(zResourceDeclaration.shape.key.safeParse(key))[''];
}

/**
 * The server's own sentence for what is wrong with a name, by its name rule as generated
 * into the SDK; `undefined` when the name is fine.
 *
 * Only the server's rule, because that is all the server checks. Discord's own
 * channel-naming rules are not applied here: Discord silently transforms a channel
 * name it dislikes rather than refusing it, so a chip claiming the save would fail
 * would be wrong.
 */
function resourceNameProblem(name: string): string | undefined {
    return fieldProblems(zResourceDeclaration.shape.defaultName.safeParse(name))[''];
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
