import type { Guild } from 'discord.js';
import { plannedDeletions, plannedRefusals, plannedSettingsKept, previewUnpublish } from '../../provisioning';
import { toPublishedResource, type PublishedResource } from './publishedFlowState';

/**
 * What a **journey** currently has live in a guild.
 *
 * The journey-scoped twin of `getPublishedFlowState`, and the shape the flows page's
 * group header asks for. The difference is the key: a flow's answer plans against the
 * journey its attachment resolves to, while a journey's plans against the key it is
 * handed, because the operator is acting on the group itself. Answering a group header
 * with one member's state — which the page did before this existed, by opening the flow
 * dialog through `flows[0]` — showed an inventory beside an uninstall the server then
 * refused as shared.
 *
 * Kept flows-side beside its twin, which shares its wire shape and its
 * `toPublishedResource`. It reads provisioning, which is the permitted direction.
 */
export interface PublishedJourneyState {
    /** What unpublishing would delete from the guild. */
    readonly deletableResources: readonly PublishedResource[];
    /** What unpublishing would refuse to touch, and why. */
    readonly refusedResources: readonly PublishedResource[];
    /** Settings unpublishing forgets and leaves standing. See `PublishedFlowState.keptSettings`. */
    readonly keptSettings: readonly PublishedResource[];
}

/**
 * Gather what a journey has live in the guild. Reads only.
 *
 * The answer is an unpublish plan rather than a binding list, for the same reason the flow
 * version gives: the dialog must show what the teardown would *really* do, refusals
 * included, or it is a preview that lies about the operation it previews.
 *
 * The journey key is taken as given rather than resolved from a flow, which is the whole
 * point of this route existing — an operator acting on the group is acting on the journey
 * itself, and there is no "asking flow" whose attachment has to be consulted.
 *
 * **Callers must have already established that the journey exists in this guild.** This
 * plans against whatever key it is handed; a key from another guild would resolve no
 * bindings and report an empty state, which reads as "nothing installed" rather than as
 * the "not found" it actually is. The routes do that check before calling.
 */
export async function getPublishedJourneyState(guild: Guild, journeyKey: string): Promise<PublishedJourneyState> {
    const plan = await previewUnpublish(guild, journeyKey);

    return {
        deletableResources: plannedDeletions(plan).map(toPublishedResource),
        refusedResources: plannedRefusals(plan).map(toPublishedResource),
        keptSettings: plannedSettingsKept(plan).map(toPublishedResource),
    };
}
