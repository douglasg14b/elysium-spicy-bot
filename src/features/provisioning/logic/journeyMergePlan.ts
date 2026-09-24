import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import type { ResourceDeclaration } from './resourceDeclaration';

/**
 * What moving a flow between journeys would do to the resources it declares.
 *
 * Grouping flows on the flows page is a drag, but underneath it is a data move, and the
 * part that is not obvious is what *stays behind*. A flow's journey link is one row and
 * moves cleanly. Its declarations and its `resource_bindings` do not:
 *
 *  - a binding is keyed `(guildId, journeyKey, resourceKey)` and nothing in this repo
 *    has ever written `journeyKey` after insert, so "move the binding" is a re-key that
 *    collides outright when the destination already claims that key, and
 *  - a graph stores a **bare** resource key with no journey qualifier
 *    (`resourceTargets.ts`), so a flow that changes journey silently changes which
 *    resource its nodes mean.
 *
 * So this decides, before anything is written, whether the two declaration sets can
 * live in one journey at all. It answers with the resources themselves rather than a
 * verdict plus a count, because every refusal and warning in this feature names what it
 * is talking about (`sharedJourneyGuard`, `buildUnpublishPlan`).
 *
 * **Why a collision is refused rather than resolved.** Merging two sets that both claim
 * `welcome-channel` would put one key against two live channels inside a single journey,
 * which the unique index on `(guildId, journeyKey, resourceKey)` cannot represent — one
 * of the two bindings simply could not exist. Renaming a key to dodge that is not this
 * function's call to make: the key is what a graph *means*, and every node pointing at
 * the old one would need rewriting. So the operator is told which keys clash and asked
 * to rename one side first.
 *
 * (Two journeys declaring the same key across *different* journeys is legal and stays
 * legal — that is what a journey being a scope buys. It briefly was not safe:
 * `applyResourcesToFlows` matched on the bare key across every flow in the guild, fixed
 * 2026-09-22 by scoping it to the journey's own flows.)
 */

/** A resource the moving flow declares, and whether it is live in the guild. */
export interface MovingResource {
    readonly key: string;
    readonly kind: ResourceDeclaration['kind'];
    /** The declared name, for a dialog that has to name things. */
    readonly declaredName: string;
    /**
     * What this resource is in Discord right now, when it has been installed.
     *
     * Present only for a settled binding with a real id. An `intended` row — written
     * before the guild was touched — is deliberately not live: there is no object to
     * orphan, so warning about one would be a warning about nothing.
     */
    readonly live: { readonly discordId: string; readonly name: string } | null;
}

/** A key both journeys declare, and what each of them means by it. */
export interface KeyCollision {
    readonly key: string;
    /** What the moving flow's journey calls it. */
    readonly movingName: string;
    /** What the destination journey calls it. */
    readonly destinationName: string;
}

/**
 * The two outcomes a move can offer, and what each costs.
 *
 * `canMerge` is not a preference — it is whether merging is *expressible* without
 * making one key mean two channels. When it is false the dialog still opens, because
 * leaving the resources behind is a legitimate choice; it is the merge option that is
 * unavailable, and it says which keys made it so.
 */
export interface JourneyMergePlan {
    /** Every resource the moving flow brings with it. Empty means a plain, silent move. */
    readonly moving: readonly MovingResource[];
    /** True when the declaration sets are disjoint and can be concatenated safely. */
    readonly canMerge: boolean;
    /** Why not, when `canMerge` is false. Empty otherwise. */
    readonly collisions: readonly KeyCollision[];
    /**
     * The resources that would be orphaned by "leave them behind" — live in the guild,
     * with nothing left that knows this bot created them.
     *
     * This is the loud half of the dialog. A declaration with no live binding is not
     * here: dropping the record of something that was never built costs nothing.
     */
    readonly orphaned: readonly MovingResource[];
}

/**
 * Work out what moving a flow's resources into another journey would do.
 *
 * Pure, and takes rows rather than repos, so the decision can be tested against the
 * cases that matter — a collision on a live key, a collision on an uninstalled one,
 * disjoint sets, and nothing to move at all — without a database.
 *
 * `movingDeclarations` is the *source journey's* declaration list, which is the set the
 * flow currently installs. When the flow shares that journey with other flows this plan
 * is not the right question to ask and the caller must refuse earlier — a shared journey
 * cannot follow one of its flows away.
 */
export function planJourneyMerge(input: {
    readonly movingDeclarations: readonly ResourceDeclaration[];
    readonly destinationDeclarations: readonly ResourceDeclaration[];
    /** Bindings under the *source* journey key, live or intended. */
    readonly movingBindings: readonly ResourceBindingEntity[];
}): JourneyMergePlan {
    const bindingByKey = new Map(
        input.movingBindings.map((binding) => [binding.resourceKey, binding] as const)
    );

    const moving: MovingResource[] = input.movingDeclarations.map((declaration) => {
        const binding = bindingByKey.get(declaration.key);
        // `intended` means the row was written but the guild was never successfully
        // touched, so there is no object to keep or to orphan. Built as a whole value
        // rather than an id plus a re-read, so the row is narrowed once.
        const live =
            binding && binding.state !== 'intended' && binding.discordId
                ? { discordId: binding.discordId, name: binding.name }
                : null;

        return {
            key: declaration.key,
            kind: declaration.kind,
            declaredName: declaration.defaultName,
            live,
        };
    });

    const destinationByKey = new Map(
        input.destinationDeclarations.map((declaration) => [declaration.key, declaration] as const)
    );

    const collisions: KeyCollision[] = [];
    for (const declaration of input.movingDeclarations) {
        const clash = destinationByKey.get(declaration.key);
        if (clash) {
            collisions.push({
                key: declaration.key,
                movingName: declaration.defaultName,
                destinationName: clash.defaultName,
            });
        }
    }

    return {
        moving,
        canMerge: collisions.length === 0,
        collisions,
        orphaned: moving.filter((resource) => resource.live !== null),
    };
}
