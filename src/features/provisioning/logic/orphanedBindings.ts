import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import type { JourneyDeclaration, ResourceKind } from './resourceDeclaration';

/**
 * Resources this journey installed and no longer declares.
 *
 * ## The gap this closes
 *
 * Remove a resource from a flow's Resources panel and the declaration goes away. The
 * **binding row and the Discord object both stay** — nothing deletes them, deliberately,
 * because deleting a live channel as a side effect of an edit is exactly the behaviour
 * `journeysRepo` and `flowJourneyLinksRepo` both have comments refusing to have.
 *
 * The result is a channel that nothing on any screen mentions. Install does not plan
 * it (no declaration). Drift does not report it (`buildJourneyDriftPlan` walks
 * declarations, and says why). Teardown's plan *does* include it, since
 * `buildUnpublishPlan` works from bindings — but only when the operator tears the whole
 * journey down, which is not what they want to do about one stray channel.
 *
 * So the object is real, ours, invisible, and permanent. This module names it.
 *
 * ## Why it is not drift
 *
 * Drift asks *is this still what we declared*. An orphan has no declaration to be
 * compared against, so the question does not apply — and "repair" would have nothing
 * to reconcile toward. It is a teardown question with two honest answers: **delete**
 * the object, or **forget** the row and leave the object alone. Both are destructive
 * in different directions, which is why this reports rather than decides.
 */

export interface OrphanedBinding {
    readonly bindingId: number;
    readonly resourceKey: string;
    readonly kind: ResourceKind;
    /** The name recorded at bind time. Diagnostics only — never a lookup key. */
    readonly name: string;
    /** Absent when the row was never settled, which makes it a `forget` either way. */
    readonly discordId?: string;
    /**
     * Whether the object is still in the guild.
     *
     * Decided by the caller, which is the only party holding a `Guild`. `false` means
     * forgetting the row is the whole of the cleanup — there is nothing left to delete.
     */
    readonly stillInGuild: boolean;
    /**
     * Whether deleting the object is permitted at all.
     *
     * `false` for an adopted binding: the operator told us it predates the journey, and
     * that promise does not lapse because the declaration was removed. The row may
     * still be forgotten; the object may not be touched.
     */
    readonly mayDelete: boolean;
}

export interface FindOrphanedBindingsInput {
    readonly journey: JourneyDeclaration;
    readonly bindings: readonly ResourceBindingEntity[];
    /**
     * Whether a bound object is still present in the guild.
     *
     * A predicate rather than a `Guild` so this stays pure and testable — the same
     * split `detectResourceDrift` takes, for the same reason.
     */
    readonly existsInGuild: (kind: ResourceKind, discordId: string) => boolean;
}

/**
 * Every binding whose resource key the journey no longer declares.
 *
 * Walks **bindings** rather than declarations — the mirror of `buildJourneyDriftPlan`,
 * which walks declarations. That is the whole difference between the two questions:
 * drift asks about things we still want and orphan-finding asks about things we have
 * and no longer asked for.
 */
export function findOrphanedBindings(
    input: FindOrphanedBindingsInput
): readonly OrphanedBinding[] {
    const declaredKeys = new Set(input.journey.resources.map((resource) => resource.key));

    return input.bindings
        .filter((binding) => !declaredKeys.has(binding.resourceKey))
        .map((binding) => ({
            bindingId: binding.id,
            resourceKey: binding.resourceKey,
            kind: binding.kind,
            name: binding.name,
            ...(binding.discordId ? { discordId: binding.discordId } : {}),
            stillInGuild:
                !!binding.discordId &&
                binding.state !== 'intended' &&
                input.existsInGuild(binding.kind, binding.discordId),
            // The adoption promise survives the declaration that referenced it.
            mayDelete: binding.state === 'created',
        }));
}

/**
 * What to tell an operator about one orphan, in words they can act on.
 *
 * States what *happened* before what can be done about it. An operator seeing this has
 * usually forgotten removing the resource, so "this is no longer declared" is the fact
 * that makes the rest make sense.
 */
export function describeOrphan(orphan: OrphanedBinding): string {
    const label = KIND_LABEL[orphan.kind];

    if (!orphan.stillInGuild) {
        return `**${orphan.name}** is no longer declared by this journey, and the ${label} is already gone from the server. Only the leftover record remains.`;
    }

    if (!orphan.mayDelete) {
        return `**${orphan.name}** is no longer declared by this journey. It was adopted rather than created here, so it will be left exactly where it is — only the record can be removed.`;
    }

    return `**${orphan.name}** is no longer declared by this journey, but the ${label} is still in your server. Nothing installs or updates it any more.`;
}

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
};
