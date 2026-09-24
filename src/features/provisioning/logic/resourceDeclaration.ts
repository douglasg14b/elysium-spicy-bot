import { declaredRoleReferencesIn } from './declaredRoleReference';
import type { PermissionIntent } from './permissionIntent';

/**
 * What kind of guild object a resource is.
 *
 * A closed union because each value has creation code behind it and an unrecognised
 * kind has nothing to fall back on — the same reasoning as `TICKET_STATUSES`. Adding
 * a kind is a deliberate edit here plus a branch in the applier, which is the point.
 *
 * Deliberately *not* `TICKET_TYPES`, which this comment used to cite: that union was
 * deleted when a ticket type became a row in `ticketing_config` rather than a branch
 * in source. Ticket *status* stayed closed for exactly the reason stated here.
 */
export const RESOURCE_KINDS = ['category', 'textChannel', 'role'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * A resource a journey needs, named by a key that is stable across guilds.
 *
 * The key is the identity; `defaultName` is only what the operator sees pre-filled.
 * That separation is what makes a journey portable: `welcome-channel` means the same
 * thing on every guild, while the channel may be called `#welcome` on one and
 * `#say-hi` on another.
 *
 * This is the correction of the ticket feature's mistake, recorded in issue #22 —
 * ticket categories are keyed by display name and match on `channel.name`, so
 * renaming a category in Discord silently routes tickets into a freshly created
 * duplicate. Bindings here resolve to ids, and a rename is invisible.
 */
export interface ResourceDeclaration {
    /** Stable across guilds and versions. Referenced by bindings and node configs. */
    readonly key: string;

    readonly kind: ResourceKind;

    /** Pre-filled in the install plan; the operator may rename it. */
    readonly defaultName: string;

    /**
     * The key of the category this belongs under, for channels.
     *
     * A key rather than a snowflake, because the parent is very often created by the
     * same install and has no id until it exists.
     */
    readonly parentKey?: string;

    /** Compiled into overwrites at apply time. Empty means "inherit from parent". */
    readonly permissions?: readonly PermissionIntent[];

    /** Shown in the plan so an operator can tell why a resource is being created. */
    readonly description?: string;

    /**
     * A guild object that already exists and should be adopted rather than created.
     *
     * The author's *standing* answer to a question install would otherwise ask them
     * every time. `ResourceChoice.adoptDiscordId` already expresses the same intent,
     * but only as an install-time input nobody supplies — the flow builder declares
     * resources long before install runs, and "this flow needs #announcements, which
     * we already have" was unsayable until it was reached. An explicit choice at
     * install still wins, so this is a default rather than a lock.
     *
     * A snowflake rather than a key, and therefore **guild-specific** in a way the
     * rest of a declaration deliberately is not: a portable journey installed on a
     * second server will not find this id and the plan blocks, naming it. That is the
     * honest outcome — an id the operator typed for *this* server cannot mean
     * anything on another one, and silently falling back to create would install a
     * duplicate of a channel they said they already had.
     */
    readonly adoptDiscordId?: string;
}

/**
 * A named bundle of flows and the resources they share.
 *
 * The *journey* owns resources, not the flow (PRD §5.7, §8 Q5): two flows in one
 * journey legitimately share a single `#welcome`, and a resource key must resolve to
 * exactly one binding. A standalone flow gets its own journey implicitly, so simple
 * cases never surface the concept.
 */
export interface JourneyDeclaration {
    readonly journeyKey: string;
    readonly name: string;
    readonly description?: string;
    readonly resources: readonly ResourceDeclaration[];
}

/**
 * Whether any resource in a journey needs a **subject** to resolve its permissions.
 *
 * A subject is the specific member a resource is about, which is a per-run fact. A
 * journey declaring one cannot be installed as shared guild structure, because there
 * is no member to resolve it against at install time.
 *
 * Asked of the declaration rather than assumed by a caller. A command that hardcoded
 * the answer would work for the journey it was written against and be wrong for
 * every other one.
 */
export function journeyNeedsSubject(journey: JourneyDeclaration): boolean {
    return journey.resources.some((resource) =>
        resource.permissions?.some((intent) => intent.audience === 'subject')
    );
}

/**
 * Whether any resource needs this guild's **staff roles** supplied.
 *
 * A genuinely different question from `journeyNeedsSubject`, and the reason the two
 * audiences are separate: staff is an ordinary guild fact known at install time, so a
 * staff-only channel is perfectly installable. It just needs the caller to say which
 * roles are staff *here*, rather than the journey hardcoding ids that would not
 * survive being installed on a second server.
 */
export function journeyNeedsStaffRoles(journey: JourneyDeclaration): boolean {
    return journey.resources.some((resource) =>
        resource.permissions?.some((intent) => intent.audience === 'staff')
    );
}

/** Raised when a declaration is internally inconsistent. */
export class ResourceDeclarationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ResourceDeclarationError';
    }
}

/**
 * Check a journey's declarations are internally coherent.
 *
 * Every failure here would otherwise surface mid-apply, with some resources already
 * created — which is exactly the half-applied state the crash-safety requirement
 * exists to avoid. Validating up front is far cheaper than unwinding.
 *
 * **An empty journey is coherent.** It used to be refused here, with the reason
 * "installing it would do nothing" — a statement about *installing*, enforced on every
 * write by `journeysRepo.create`. That was right while the only way to make a journey
 * was to declare a resource, and wrong the moment grouping shipped: dragging two flows
 * together creates the journey that will hold their resources, and refusing it told an
 * operator their two empty flows could not be grouped. Emptiness is now
 * {@link assertInstallable}'s business, asked at install where it is true.
 */
export function validateJourneyDeclaration(journey: JourneyDeclaration): void {
    const byKey = new Map<string, ResourceDeclaration>();
    for (const resource of journey.resources) {
        if (byKey.has(resource.key)) {
            throw new ResourceDeclarationError(
                `Journey "${journey.journeyKey}" declares the resource key "${resource.key}" more than once. A key must resolve to exactly one binding.`
            );
        }
        byKey.set(resource.key, resource);
    }

    for (const resource of journey.resources) {
        if (!resource.parentKey) continue;

        const parent = byKey.get(resource.parentKey);
        if (!parent) {
            throw new ResourceDeclarationError(
                `Resource "${resource.key}" names parent "${resource.parentKey}", which this journey does not declare.`
            );
        }
        if (parent.kind !== 'category') {
            throw new ResourceDeclarationError(
                `Resource "${resource.key}" names parent "${resource.parentKey}", which is a ${parent.kind}. Only a category can be a parent.`
            );
        }
        if (resource.kind === 'role') {
            throw new ResourceDeclarationError(
                `Role "${resource.key}" declares a parent. Roles do not live under categories.`
            );
        }
        // Discord categories do not nest, and `applyInstallPlan`'s category branch
        // creates with no `parent` argument at all — so a category's parent was
        // accepted, stored, and silently ignored. Refused here rather than left as a
        // field that looks like it does something.
        if (resource.kind === 'category') {
            throw new ResourceDeclarationError(
                `Category "${resource.key}" declares a parent. Categories do not nest inside other categories.`
            );
        }
    }

    // Two resources adopting the same guild object is the binding table's uniqueness
    // read backwards: a key resolves to exactly one object, and nothing stops two keys
    // resolving to the *same* one. The apply would happily bind both, and every later
    // question — which key owns this channel, what does unmanaging one do to the other
    // — has two answers. `buildInstallPlan` cannot catch it, since it judges each
    // resource alone; only something holding the whole journey can.
    //
    // Scoped to one journey because that is all this function sees, and deliberately:
    // two journeys adopting one channel is the shared-resource case 5B has to handle
    // anyway, and adoption mutates nothing, so it is harmless until uninstall exists
    // to be confused by it. Within a journey it is unambiguously a mistake.
    const adoptedBy = new Map<string, string>();
    for (const resource of journey.resources) {
        if (!resource.adoptDiscordId) continue;

        const alreadyAdoptedBy = adoptedBy.get(resource.adoptDiscordId);
        if (alreadyAdoptedBy) {
            throw new ResourceDeclarationError(
                `Resources "${alreadyAdoptedBy}" and "${resource.key}" both adopt ${resource.adoptDiscordId}. One guild object cannot be two resources.`
            );
        }
        adoptedBy.set(resource.adoptDiscordId, resource.key);
    }

    // A permission may name a role this journey creates, by key rather than by
    // snowflake. The same reasoning as the parent check above applies, and more
    // sharply: an unknown key here is not caught until `compilePermissionIntents`
    // throws *mid-apply*, with channels already created — the half-applied state this
    // whole validation pass exists to prevent.
    for (const resource of journey.resources) {
        for (const referencedKey of declaredRoleReferencesIn(resource.permissions)) {
            const referenced = byKey.get(referencedKey);
            if (!referenced) {
                throw new ResourceDeclarationError(
                    `Resource "${resource.key}" has a permission naming the role "${referencedKey}", which this journey does not declare.`
                );
            }
            // A self-reference cannot reach here: it would have to name a resource
            // whose kind is `role`, and a role's own permissions are never compiled
            // (roles have no overwrites). The kind check below covers every other
            // shape of it, so there is no separate self-reference branch to write.
            if (referenced.kind !== 'role') {
                throw new ResourceDeclarationError(
                    `Resource "${resource.key}" has a permission naming "${referencedKey}" as a role, but this journey declares it as a ${referenced.kind}. Only a role can appear in a permission.`
                );
            }
        }
    }
}

/**
 * Refuse a journey that has nothing to install.
 *
 * Split out of {@link validateJourneyDeclaration} so that *storing* an empty journey and
 * *installing* one are different questions. An empty journey is a perfectly good record —
 * it is what grouping two flows with no resources yet produces, and what a journey looks
 * like the moment before its first resource is declared. It is only meaningless as an
 * install, which is the one caller that should ask.
 */
export function assertInstallable(journey: JourneyDeclaration): void {
    if (journey.resources.length === 0) {
        throw new ResourceDeclarationError(
            `Journey "${journey.journeyKey}" declares no resources, so installing it would do nothing.`
        );
    }
}

/**
 * Every resource key one resource must be created *after*.
 *
 * Two kinds of edge, and the second is the one that was missing:
 *
 *  - **`parentKey`** — a channel cannot be placed in a category that does not exist.
 *  - **A declared role named in this resource's permissions** — the role must exist
 *    before its id can go into an overwrite.
 *
 * Without the second edge a channel whose permissions reference a declared role has
 * no ordering relationship to that role at all, so it can be created first.
 * `compilePermissionIntents` then refuses (correctly — it will not silently create a
 * channel less restricted than asked for), but it refuses **mid-apply**, with
 * channels already in the guild. That is precisely the half-applied state the
 * record-intent-before-mutating design exists to prevent, reached by a route that
 * design could not see.
 */
function dependenciesOf(resource: ResourceDeclaration): readonly string[] {
    const roleKeys = declaredRoleReferencesIn(resource.permissions);
    return resource.parentKey ? [resource.parentKey, ...roleKeys] : roleKeys;
}

/**
 * Order resources so everything a resource depends on is created before it.
 *
 * A plain topological sort over {@link dependenciesOf}. Categories are only one level
 * deep in Discord, so the parent chain cannot recurse far, but it is written generally
 * because the alternative — assuming categories sort first — silently breaks the day a
 * declaration lists a channel before its category, and because role references are not
 * depth-bounded in the same way.
 */
export function orderResourcesForApply(
    resources: readonly ResourceDeclaration[]
): readonly ResourceDeclaration[] {
    const remaining = new Map(resources.map((resource) => [resource.key, resource]));
    const ordered: ResourceDeclaration[] = [];
    const placed = new Set<string>();

    while (remaining.size > 0) {
        const ready = [...remaining.values()].filter((resource) =>
            dependenciesOf(resource).every((dependency) => placed.has(dependency))
        );

        if (ready.length === 0) {
            // `validateJourneyDeclaration` rejects unknown parents and unknown role
            // references, so the only way to reach this is a cycle. Naming the
            // participants beats a hang.
            throw new ResourceDeclarationError(
                `Resource dependency cycle among: ${[...remaining.keys()].join(', ')}.`
            );
        }

        for (const resource of ready) {
            ordered.push(resource);
            placed.add(resource.key);
            remaining.delete(resource.key);
        }
    }

    return ordered;
}
