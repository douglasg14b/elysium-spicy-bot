import type {
    PublishedButtonMessage,
    PublishedFlowState,
    PublishedResource,
} from '../../features/flows/logic/publishedFlowState';
import type { PublishedJourneyState } from '../../features/flows/logic/publishedJourneyState';

/**
 * The response body, named so the contract is a type rather than an inference.
 *
 * `buttonMessages` is deliberately `PublishedButtonMessage` and not the journey's
 * `flowId`-carrying variant: the extra field has no consumer, and widening the wire to
 * whatever the richer internal shape happens to hold is how fields reach clients without
 * anyone deciding they should. Narrowing here means the journey route sends exactly what
 * the flow route sends, which is what lets the browser hold one type for both.
 */
export interface PublishedBody {
    readonly buttonMessages: readonly PublishedButtonMessage[];
    readonly deletableResources: readonly PublishedResource[];
    readonly refusedResources: readonly PublishedResource[];
    readonly mayHaveUnrecordedButtons: boolean;
}

/**
 * The wire shape for what a flow or a journey has live in the guild.
 *
 * Shared by `flowRoutes` and `journeyRoutes` rather than duplicated, so the browser can
 * hold **one** `PublishedFlowState` type and point both dialogs at it. Two copies of this
 * would be two chances for a field to be added on one side only — and the field most
 * likely to be forgotten is `mayHaveUnrecordedButtons`, whose whole job is to stop a
 * dialog claiming nothing is published when the data cannot support that claim.
 *
 * Fields are listed explicitly rather than spread from the state. These objects are
 * response bodies: a future field added to the internal state would otherwise reach the
 * wire the moment it was declared, without anyone deciding it should.
 */
export function publishedBody(state: PublishedFlowState | PublishedJourneyState): PublishedBody {
    return {
        buttonMessages: state.buttonMessages.map((message) => ({
            channelId: message.channelId,
            messageId: message.messageId,
            nodeIds: message.nodeIds,
        })),
        deletableResources: state.deletableResources,
        refusedResources: state.refusedResources,
        mayHaveUnrecordedButtons: state.mayHaveUnrecordedButtons,
    };
}
