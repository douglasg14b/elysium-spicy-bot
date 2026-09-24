/**
 * Which endpoint a declaration list is read from and written to.
 *
 * Two surfaces edit the same declarations and neither one can use the other's endpoint:
 *
 *  - the **builder** edits a flow's resources and reaches them through the flow
 *    (`/flows/:flowId/resources`), which resolves the journey server-side. It genuinely
 *    does not know the journey key up front — a flow that has never declared anything has
 *    no journey row at all, and the PUT is what creates one.
 *  - the **group header** on the flows page edits a *journey's* resources. Routing that
 *    through a member flow would be wrong rather than merely indirect: the header is a
 *    journey, and picking `flows[0]` to speak for it is the exact mistake
 *    `JourneyResourcesDialog` was written to undo on the teardown side, where one member's
 *    inventory was shown beside an action that reached all of them. It would also be
 *    fragile in a way the operator would feel — the flow it happened to pick can leave the
 *    group mid-edit.
 *
 * So the journey-scoped dialog saves with `PUT /journeys/:journeyKey`, which already accepts
 * `{ resources }` and validates them identically — both routes parse with the same
 * `resourceSchema` and both land in `journeysRepo.update`, so there is no validation gap
 * between them.
 *
 * **It is also the only one of the two that would work at all.** `PUT /flows/:flowId/resources`
 * refuses *every* write to a journey another flow also holds — a 409 carrying
 * `sharedJourneyRefusal`, on the clear path and the replace path alike
 * (`journeyRoutes.ts`) — and a group header is shared by definition, since a journey of one
 * is not drawn as a group. Routing the header's edits through a member flow would therefore
 * be rejected on the first keystroke that reached the server.
 *
 * That refusal is right, and it is what this route is for: it protects flows an operator
 * cannot see from a write started on one of their siblings. Acting on the journey itself is
 * the case it steers them towards, which is the same argument `JourneyResourcesDialog` makes
 * for the teardown routes.
 *
 * A discriminated union rather than two optional ids, so a caller cannot supply both or
 * neither, and so `loadResources`/`storeResources` below can be exhaustive.
 */

import {
    getFlowResources,
    getJourneyResources,
    saveFlowResources,
    updateJourney,
} from '../api/journeys';
import type { ResourceDeclaration } from '../api/types';

export type ResourceSaveTarget =
    /** The builder: keyed on the flow, journey resolved server-side. */
    | { readonly kind: 'flow'; readonly flowId: string }
    /** The flows page's group header: keyed on the journey itself. */
    | { readonly kind: 'journey'; readonly journeyKey: string };

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

/** Read what the target currently declares. */
export function loadResources(
    guildId: string,
    target: ResourceSaveTarget
): Promise<ResourceDeclaration[]> {
    switch (target.kind) {
        case 'flow':
            return getFlowResources(guildId, target.flowId);
        case 'journey':
            return getJourneyResources(guildId, target.journeyKey);
        default: {
            const unhandled: never = target;
            throw new Error(`Unhandled resource save target: ${JSON.stringify(unhandled)}`);
        }
    }
}

/** Replace what the target declares, returning the server's normalised copy. */
export function storeResources(
    guildId: string,
    target: ResourceSaveTarget,
    resources: ResourceDeclaration[]
): Promise<ResourceDeclaration[]> {
    switch (target.kind) {
        case 'flow':
            return saveFlowResources(guildId, target.flowId, resources);
        case 'journey':
            // `PUT /journeys/:key` answers with the whole journey; only the declarations
            // are of interest, and unwrapping here keeps both arms returning the same
            // shape so the autosave never has to know which endpoint it used.
            return updateJourney(guildId, target.journeyKey, { resources }).then(
                (journey) => journey.resources
            );
        default: {
            const unhandled: never = target;
            throw new Error(`Unhandled resource save target: ${JSON.stringify(unhandled)}`);
        }
    }
}
