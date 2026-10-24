import type { UploadUse } from '../../../features-system/guild-uploads';
import { messageUploadPlaces } from '../../../shared/discordMessage';
import { flowDraftsRepo } from '../data/flowDraftsRepo';
import type { FlowGraph } from '../data/flowGraph';
import { flowsRepo } from '../data/flowsRepo';
import { messageFieldsOf } from './uploadReferences';

/** The flow a graph belongs to, and whose draft it is when it is one. */
interface GraphOwner {
    readonly flowId: string;
    readonly flowName: string;
    readonly draftAuthorId?: string;
}

/**
 * One use per place a graph's messages show an upload: a picture shown twice is two uses.
 * Hidden fields count — a field its `visibleWhen` hides still holds the picture, and
 * switching the choice back would show it again.
 */
function usesInGraph(graph: FlowGraph, owner: GraphOwner): UploadUse[] {
    return graph.nodes.flatMap((node) =>
        messageFieldsOf(node).flatMap(({ block, field }) =>
            messageUploadPlaces(node.data[field.key]).map(
                (place): UploadUse => ({
                    uploadId: place.uploadId,
                    flowId: owner.flowId,
                    flowName: owner.flowName,
                    nodeId: node.id,
                    blockLabel: block.label,
                    where: place.where,
                    ...(owner.draftAuthorId === undefined ? {} : { draftAuthorId: owner.draftAuthorId }),
                })
            )
        )
    );
}

/** What makes two uses the same place: the upload, the flow's node, and the part. */
function placeKey(use: UploadUse): string {
    return JSON.stringify([use.uploadId, use.flowId, use.nodeId, use.where]);
}

/**
 * Every use flows makes of a guild's uploads: each saved flow's graph, then each draft's use
 * the saved flow does not already make, marked with its author — deleting a picture only a
 * draft shows would quietly break somebody's unsaved work. A draft is named as its canvas has
 * it, since a rename is part of the draft.
 *
 * Found by the `message` control, never by block type, so any block holding a message is
 * covered; a node whose block is gone is skipped. Read straight from the repos and never
 * inside a transaction — SQLite has one connection. Registered with guild-uploads by
 * `initFlows`.
 *
 * **Drafts are read before flows.** A save that lands on the flow writes its graph and
 * discards its author's draft in one commit, so a picture moving from a draft to the flow
 * between the two reads is still seen by the second. Read the other way round, it would be in
 * neither, and a delete would take a picture the flow had just been saved with.
 */
export async function flowUploadUses(guildId: string): Promise<readonly UploadUse[]> {
    const drafts = await flowDraftsRepo.listByGuildId(guildId);
    const flows = await flowsRepo.getByGuildId(guildId);

    const saved = flows.flatMap((flow) => usesInGraph(flow.graph, { flowId: flow.flowId, flowName: flow.name }));
    const savedPlaces = new Set(saved.map(placeKey));
    const draftOnly = drafts
        .flatMap((draft) => usesInGraph(draft.graph, { flowId: draft.flowId, flowName: draft.name, draftAuthorId: draft.authorId }))
        .filter((use) => !savedPlaces.has(placeKey(use)));

    return [...saved, ...draftOnly];
}
