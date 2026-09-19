import { declaredRoleReferencesIn } from './declaredRoleReference';
import type { PermissionIntent } from './permissionIntent';

/**
 * What kind of guild object a resource is.
 *
 * A closed union because each value has creation code behind it and an unrecognised
 * kind has nothing to fall back on — the same reasoning as `TICKET_TYPES`. Adding a
 * kind is a deliberate edit here plus a branch in the applier, which is the point.
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
 * Check a journey's declarations before anything touches the guild.
 *
 * Every failure here would otherwise surface mid-apply, with some resources already
 * created — which is exactly the half-applied state the crash-safety requirement
 * exists to avoid. Validating up front is far cheaper than unwinding.
 */
export function validateJourneyDeclaration(journey: JourneyDeclaration): void {
    if (journey.resources.length === 0) {
        throw new ResourceDeclarationError(
            `Journey "${journey.journeyKey}" declares no resources, so installing it would do nothing.`
        );
    }

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
