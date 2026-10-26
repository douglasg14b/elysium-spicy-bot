/**
 * Which endpoint a declaration list is read from and written to.
 *
 * Two endpoints write the same declarations:
 *
 *  - **through the flow** (`/flows/:flowId/resources`), which resolves the journey
 *    server-side. It is the only way in for a flow that has never declared anything — it has
 *    no journey row at all, and this PUT is what creates one — and for a flow from before the
 *    link table, whose save here writes its link.
 *  - **through the journey** (`PUT /journeys/:journeyKey`), which accepts `{ resources }` and
 *    validates them identically — both routes parse with the same `ResourceDeclaration`
 *    schema and both write through `journeysRepo.updateAtVersion`, so there is no validation
 *    gap between them.
 *
 * The **group header** on the flows page always saves through the journey: it *is* a
 * journey, and routing its edits through `flows[0]` would pick an arbitrary member to speak
 * for the whole group — the mistake `JourneyResourcesDialog` was written to undo on the
 * teardown side.
 *
 * The **builder** saves through its journey too, once the flow is linked to one
 * ({@link builderResourcesTarget}; step 3, pick 7). That reverses what this module used to
 * record: the flow route refuses, with a 409 carrying `sharedJourneyRefusal`, every write to
 * a journey another flow also holds, which was kept as protecting flows an operator cannot
 * see from a write started on a sibling. It also meant no grouped flow could declare
 * anything from its own builder — so the Button Click trigger's "+ New button" would have been
 * refused in every grouped flow. Douglas took the reversal on one condition, now built: both
 * routes refuse, with a 409 telling the operator to reload, a list edited from a version of
 * the journey that has since moved on (see {@link StoredResources}). A sibling's save is
 * never overwritten unseen; the refusal sends the operator to reload and see it. The flow
 * route still answers its shared-journey 409, now only to a flow still on its pre-link
 * fallback, which saves through the flow until its link exists.
 *
 * A discriminated union rather than two optional ids, so a caller cannot supply both or
 * neither, and so `loadResources`/`storeResources` below can be exhaustive.
 */

import {
    getFlowResources,
    getJourney,
    saveFlowResources,
    updateJourney,
    type FlowAttachment,
    type ResourceDeclaration,
} from '@brattybot/web-sdk';

export type ResourceSaveTarget =
    /** Keyed on the flow, journey resolved server-side: a builder whose flow has no link yet. */
    | { readonly kind: 'flow'; readonly flowId: string }
    /** Keyed on the journey itself: the group header, and a builder whose flow is linked. */
    | { readonly kind: 'journey'; readonly journeyKey: string };

/**
 * Where the builder saves a flow's declarations: through its journey once a link row names
 * it, through the flow before.
 *
 * Through the flow while there is no journey — its first save creates one, keyed by the
 * flow's id — and while the journey is only the pre-link fallback (`linked: false`): the
 * flow's save writes the link, and the journey's would not (review item 33). The builder
 * re-reads the attachment after a save through the flow, and the next save goes through the
 * journey under the same autosave identity (`useResourceAutosave`'s `subject`), so the
 * version the first answered with carries over.
 */
export function builderResourcesTarget(flowId: string, attachment: FlowAttachment | null): ResourceSaveTarget {
    return attachment?.linked ? { kind: 'journey', journeyKey: attachment.journeyKey } : { kind: 'flow', flowId };
}

/**
 * The target as one string, for the autosave's bookkeeping identity.
 *
 * The kind is part of it so a flow id and a journey key that happen to be equal — which is
 * the *normal* case for the implicit single-flow journey, keyed on the flow's own id —
 * cannot be mistaken for one another. Without the prefix, opening the builder for flow `X`
 * and then the group header for journey `X` would share a baseline, and the second list
 * loaded would be read as an edit of the first and written straight back.
 */
export function resourceTargetIdentity(target: ResourceSaveTarget): string {
    return target.kind === 'flow' ? `flow:${target.flowId}` : `journey:${target.journeyKey}`;
}

/**
 * A target's declarations as the server holds them, and the version they were read at.
 *
 * `updatedAt` is the journey's, and every save sends back the one its list was edited from
 * (`baseUpdatedAt`): both routes replace the whole list, so a save from a tab that loaded
 * before somebody else's would delete what that one added, and the server refuses it with a
 * 409 instead. `null` for a flow on no journey yet — the first save creates one, and has no
 * version to send.
 */
export interface StoredResources {
    readonly resources: ResourceDeclaration[];
    readonly updatedAt: string | null;
}

/**
 * Read what the target currently declares.
 *
 * Direct SDK calls rather than queries: the autosave owns the ordering of its reads and
 * writes (`resourceSaveQueue.ts`), and a cache would be a second owner of the same list.
 */
export function loadResources(guildId: string, target: ResourceSaveTarget): Promise<StoredResources> {
    switch (target.kind) {
        case 'flow':
            return getFlowResources({ path: { guildId, flowId: target.flowId } }).then(({ data }) => ({
                resources: data.resources,
                updatedAt: data.updatedAt,
            }));
        case 'journey':
            // The journey itself, not a member flow — see the header. A 404 means no such
            // journey in this guild, including one belonging to another guild, which is
            // deliberately indistinguishable.
            return getJourney({ path: { guildId, journeyKey: target.journeyKey } }).then(({ data }) => ({
                resources: data.resources,
                updatedAt: data.updatedAt,
            }));
        default: {
            const unhandled: never = target;
            throw new Error(`Unhandled resource save target: ${JSON.stringify(unhandled)}`);
        }
    }
}

/**
 * Replace what the target declares, returning the server's normalised copy and the version
 * the next save sends.
 *
 * @param baseUpdatedAt - The version `resources` was edited from: the last load's or the last
 * save's `updatedAt`. `null` only for a flow on no journey yet.
 */
export function storeResources(
    guildId: string,
    target: ResourceSaveTarget,
    resources: ResourceDeclaration[],
    baseUpdatedAt: string | null
): Promise<StoredResources> {
    const body = { resources, baseUpdatedAt: baseUpdatedAt ?? undefined };

    switch (target.kind) {
        case 'flow':
            // An empty list removes the flow's journey entirely.
            return saveFlowResources({ path: { guildId, flowId: target.flowId }, body }).then(({ data }) => ({
                resources: data.resources,
                updatedAt: data.updatedAt,
            }));
        case 'journey':
            // `PUT /journeys/:key` answers with the whole journey; only the declarations
            // and the version are of interest, and unwrapping here keeps both arms returning
            // the same shape so the autosave never has to know which endpoint it used.
            return updateJourney({ path: { guildId, journeyKey: target.journeyKey }, body }).then(({ data }) => ({
                resources: data.resources,
                updatedAt: data.updatedAt,
            }));
        default: {
            const unhandled: never = target;
            throw new Error(`Unhandled resource save target: ${JSON.stringify(unhandled)}`);
        }
    }
}
