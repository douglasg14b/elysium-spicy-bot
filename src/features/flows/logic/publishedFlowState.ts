import type { Guild } from 'discord.js';
import {
    previewUnpublish,
    plannedDeletions,
    plannedRefusals,
    type RefusalReason,
} from '../../provisioning';
import { flowButtonMessagesRepo, type FlowButtonMessagesRepo } from '../data/flowButtonMessagesRepo';

/**
 * What a flow currently has live in a guild.
 *
 * Answers the one question a delete dialog needs: *if I delete this flow, what is left
 * behind in the server?* Both halves are here because both outlive the flow row —
 * buttons stay posted in their channels, and bindings deliberately survive so the
 * channels they name can still be found.
 *
 * ## Why this lives flows-side
 *
 * It reads provisioning, and that is the permitted direction: flows may depend on
 * provisioning, never the reverse. Provisioning is a base capability that must not know
 * flows exist — which is why the resource write-back is a registered callback rather
 * than an import. Nothing here needs that seam, because nothing here asks provisioning
 * to know anything about a flow; it asks about a journey key, which is provisioning's
 * own vocabulary.
 *
 * It also lives in `logic/` rather than `data/`, because the vocabulary gate covers
 * `flows/data` and this legitimately names a journey.
 */
export interface PublishedButtonMessage {
    readonly channelId: string;
    readonly messageId: string;
    readonly nodeIds: readonly string[];
}

export interface PublishedResource {
    readonly resourceKey: string;
    readonly kind: string;
    readonly name: string;
    readonly discordId?: string;
    /** True when unpublishing would refuse this one. See `refusalReason` for why. */
    readonly refused: boolean;
    /**
     * Why this one is refused, when it is.
     *
     * On the wire rather than left to the browser to infer from prose, because the
     * reasons are not interchangeable and a UI that groups them has to tell them
     * apart. A category refused because someone added a channel inside it *was*
     * created by this flow — describing it as "adopted" states the opposite of the
     * truth about who owns it.
     */
    readonly refusalReason?: RefusalReason;
    readonly explanation?: string;
    /** For `category-has-survivors`: what is still inside, by name. */
    readonly survivors?: readonly string[];
}

export interface PublishedFlowState {
    /** Messages carrying this flow's trigger buttons, as far as we recorded them. */
    readonly buttonMessages: readonly PublishedButtonMessage[];
    /** What unpublishing would delete from the guild. */
    readonly deletableResources: readonly PublishedResource[];
    /** What unpublishing would refuse to touch, and why. */
    readonly refusedResources: readonly PublishedResource[];
    /**
     * Whether buttons posted before this was recorded may still be out there.
     *
     * Always true, and deliberately not computed: the table was not backfilled, and it
     * *cannot* be — the message ids of earlier deploys were never written down. A
     * dialog that said "nothing is published" on the strength of an empty table would
     * be making a promise this data cannot support. The UI says so plainly instead.
     */
    readonly mayHaveUnrecordedButtons: true;
}

interface PublishedFlowStateDeps {
    readonly buttonMessagesRepo?: Pick<FlowButtonMessagesRepo, 'listByFlowId'>;
}

/**
 * Gather what a flow has live in the guild. Reads only.
 *
 * The resource half is answered by building an unpublish plan rather than by listing
 * bindings, so the dialog shows exactly what the teardown would really do — including
 * the refusals. Listing bindings would let the dialog promise a deletion that unpublish
 * then refuses, which is the preview lying about the operation it is previewing.
 *
 * A flow's journey key is its flow id, which is the convention the resource routes
 * already use.
 */
export async function getPublishedFlowState(
    guild: Guild,
    flowId: string,
    deps: PublishedFlowStateDeps = {}
): Promise<PublishedFlowState> {
    const repo = deps.buttonMessagesRepo ?? flowButtonMessagesRepo;

    const [recorded, plan] = await Promise.all([
        repo.listByFlowId(guild.id, flowId),
        previewUnpublish(guild, flowId),
    ]);

    return {
        buttonMessages: recorded.map((row) => ({
            channelId: row.channelId,
            messageId: row.messageId,
            nodeIds: row.nodeIds,
        })),
        deletableResources: plannedDeletions(plan).map(toPublishedResource),
        refusedResources: plannedRefusals(plan).map(toPublishedResource),
        mayHaveUnrecordedButtons: true,
    };
}

function toPublishedResource(item: {
    resourceKey: string;
    kind: string;
    name: string;
    discordId?: string;
    action: string;
    refusalReason?: RefusalReason;
    explanation?: string;
    survivors?: readonly string[];
}): PublishedResource {
    return {
        resourceKey: item.resourceKey,
        kind: item.kind,
        name: item.name,
        discordId: item.discordId,
        refused: item.action === 'refuse',
        refusalReason: item.refusalReason,
        explanation: item.explanation,
        survivors: item.survivors,
    };
}
