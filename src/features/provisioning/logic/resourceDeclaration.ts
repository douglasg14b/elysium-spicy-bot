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
}

/**
 * Order resources so a parent is always created before its children.
 *
 * A plain topological sort over `parentKey`. Categories are only one level deep in
 * Discord, so this cannot recurse far, but it is written generally because the
 * alternative — assuming categories sort first — silently breaks the day a
 * declaration lists a channel before its category.
 */
export function orderResourcesForApply(
    resources: readonly ResourceDeclaration[]
): readonly ResourceDeclaration[] {
    const remaining = new Map(resources.map((resource) => [resource.key, resource]));
    const ordered: ResourceDeclaration[] = [];
    const placed = new Set<string>();

    while (remaining.size > 0) {
        const ready = [...remaining.values()].filter(
            (resource) => !resource.parentKey || placed.has(resource.parentKey)
        );

        if (ready.length === 0) {
            // `validateJourneyDeclaration` rejects unknown parents, so the only way
            // to reach this is a parent cycle. Naming the participants beats a hang.
            throw new ResourceDeclarationError(
                `Resource parent cycle among: ${[...remaining.keys()].join(', ')}.`
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
