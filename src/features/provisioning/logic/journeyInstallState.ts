/**
 * How much of what a journey declares is actually in the guild.
 *
 * The flows list shows this per row, so it has to be answerable for every journey in a
 * guild at once and without asking Discord. That rules out the published/teardown routes,
 * which plan a real teardown against live channels: correct, and far too expensive to run
 * once per row on a page load.
 *
 * What this reads instead is the **binding table**, which is the guild-side record of what
 * install did. It is a weaker claim than the teardown routes make — a binding says we
 * created or adopted something, not that it still exists this second — and the state below
 * is named to keep that honest. It answers "has this been installed?", which is the
 * question the chip asks, rather than "is this intact right now?", which is what opening
 * the inventory answers properly.
 *
 * ## Why `intended` is not installed
 *
 * A binding row is written **before** the guild is mutated, so a crash mid-install leaves
 * an `intended` row with no `discordId` (see `resourceBindingsSchema.ts`). Counting those
 * would report a journey as installed on the strength of an install that failed — and the
 * chip's entire job is telling an operator whether to press install. Only rows that made it
 * to `created` or `adopted` count.
 */

import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';

/**
 * Whether a journey's declared resources are in the guild, as three states.
 *
 * `partial` is a first-class answer rather than a rounding of the other two. It is what a
 * failed-halfway install looks like, what adding a resource to an already-installed journey
 * looks like, and the one state where "install" means "finish" rather than "start" — so
 * collapsing it into `none` would offer to create things that already exist, and collapsing
 * it into `all` would hide the fact that a flow is referencing a channel that is not there.
 */
export type JourneyInstallState = 'none' | 'partial' | 'all';

export interface JourneyInstallSummary {
    readonly state: JourneyInstallState;
    /** Declared resources with a live binding. */
    readonly installedCount: number;
    /** How many the journey declares. Zero means there is nothing to install. */
    readonly declaredCount: number;
    /**
     * Which declared keys have a live binding, not merely how many.
     *
     * The names as well as the count because the flows page needs both, for two different
     * questions: the chip asks "how much of this is there?", and the declarations editor
     * asks, per resource, "may this key still follow its name?" — which it may not once a
     * binding points at it, since `resource_bindings` rows and node `<field>Key` sidecars
     * would be orphaned by a change.
     *
     * Carried on the list row rather than fetched separately by the editor. It is the same
     * set already computed here, and the alternative — the editor asking the server on open
     * — would give the group header and the builder two different answers to one rule about
     * one resource, which is how the surfaces come to disagree.
     */
    readonly installedKeys: readonly string[];
}

/**
 * Whether a binding names something that actually reached the guild.
 *
 * Both halves are required. `state` distinguishes a real install from the pre-flight
 * intent; `discordId` is the thing an operator could go and look at, and a `created` row
 * without one is a record we cannot act on — `buildUnpublishPlan` cannot delete it and the
 * install reconciler treats it as unfinished.
 */
function isLive(binding: ResourceBindingEntity): boolean {
    return binding.state !== 'intended' && !!binding.discordId;
}

/**
 * Summarise one journey's install state from its declarations and its bindings.
 *
 * Bindings are matched to declarations **by resource key**, and bindings naming a key the
 * journey no longer declares are ignored rather than counted. That case is ordinary: an
 * operator deletes a resource from the panel and the binding survives until a teardown
 * removes the channel. Counting it would let a journey report more installed than declared,
 * and — with the arithmetic below — show `all` for a journey none of whose current
 * resources exist.
 */
export function summariseJourneyInstall(input: {
    readonly declaredKeys: readonly string[];
    readonly bindings: readonly ResourceBindingEntity[];
}): JourneyInstallSummary {
    const liveKeys = new Set(
        input.bindings.filter(isLive).map((binding) => binding.resourceKey)
    );

    const declaredCount = input.declaredKeys.length;
    // Derived from the declarations rather than from the bindings, so a binding naming a
    // key the journey no longer declares contributes to neither the count nor the list.
    const installedKeys = input.declaredKeys.filter((key) => liveKeys.has(key));
    const installedCount = installedKeys.length;

    // A journey declaring nothing is `none` rather than vacuously `all`. Nothing is
    // installed, and more usefully there is nothing to install — the caller suppresses the
    // chip entirely on a zero count, which it can only do if this does not claim success.
    if (declaredCount === 0) {
        return { state: 'none', installedCount: 0, declaredCount: 0, installedKeys: [] };
    }

    const state: JourneyInstallState =
        installedCount === 0 ? 'none' : installedCount === declaredCount ? 'all' : 'partial';

    return { state, installedCount, declaredCount, installedKeys };
}

/**
 * Group a guild's bindings by journey key, for one pass over the whole list.
 *
 * Here rather than inline in the route so the flows list can resolve every row from a
 * single query — the N+1 `loadFlowJourneyIndex` exists to avoid, one table across.
 */
export function groupBindingsByJourney(
    bindings: readonly ResourceBindingEntity[]
): ReadonlyMap<string, ResourceBindingEntity[]> {
    const byJourney = new Map<string, ResourceBindingEntity[]>();

    for (const binding of bindings) {
        const existing = byJourney.get(binding.journeyKey);
        if (existing) existing.push(binding);
        else byJourney.set(binding.journeyKey, [binding]);
    }

    return byJourney;
}
