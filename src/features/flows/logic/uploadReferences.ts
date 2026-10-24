import { guildUploadsRepo } from '../../../features-system/guild-uploads';
import { messageUploadIds, messageUploadProblems } from '../../../shared/discordMessage';
import { isFieldVisible, type BlockConfigField, type BlockManifest } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type { FlowGraph } from '../data/flowGraph';
import type { FlowValidationIssue } from '../engine/nodeDataValidation';

/**
 * What the flow's server holds of the uploads some graphs name, read once so readiness can
 * stay synchronous — it is asked inside `flowsRepo.mutate`'s transaction, where a query on
 * SQLite's one connection would deadlock.
 *
 * An index answers only for the graphs it was loaded for: `named` is every upload id they
 * name, and `sizes` holds those of them this server has. A named id missing from `sizes` is
 * not in this server — deleted, or copied from another server's flow.
 */
export interface UploadIndex {
    readonly named: ReadonlySet<string>;
    readonly sizes: ReadonlyMap<string, number>;
}

/** A `message` field of a node, with the block declaring it. */
export interface NodeMessageField {
    readonly block: BlockManifest;
    readonly field: BlockConfigField;
    /** Whether the node's choices show the field; a hidden one still holds its value. */
    readonly visible: boolean;
}

/**
 * Every `message` field a node's block declares — found by control, never by block. A node
 * whose block is not registered (removed since, say) has none.
 */
export function messageFieldsOf(node: FlowGraph['nodes'][number]): readonly NodeMessageField[] {
    const block = getBlockDefinition(node.type);
    if (!block) return [];
    return block.configFields
        .filter((field) => field.control === 'message')
        .map((field) => ({ block, field, visible: isFieldVisible(field, block.configFields, node.data) }));
}

/**
 * Every upload id the graphs' messages name, hidden fields included — so an index loaded for
 * a graph covers it however its choices are set.
 */
function uploadIdsIn(graphs: readonly FlowGraph[]): ReadonlySet<string> {
    const named = new Set<string>();
    for (const graph of graphs) {
        for (const node of graph.nodes) {
            for (const { field } of messageFieldsOf(node)) {
                for (const uploadId of messageUploadIds(node.data[field.key])) {
                    named.add(uploadId);
                }
            }
        }
    }
    return named;
}

/**
 * The {@link UploadIndex} for these graphs in this guild: one query for the sizes of the
 * uploads they name, read for **this guild only**, and **no query at all** when they name
 * none — which is every flow without an uploaded picture.
 *
 * Await it before `flowsRepo.mutate`, never inside the callback: SQLite has one connection,
 * and a query inside the transaction waits on it forever.
 */
export async function loadUploadIndex(guildId: string, graphs: readonly FlowGraph[]): Promise<UploadIndex> {
    const named = uploadIdsIn(graphs);
    if (named.size === 0) {
        return { named, sizes: new Map() };
    }
    const held = await guildUploadsRepo.sizesFor(guildId, [...named]);
    return { named, sizes: new Map(held.map((upload) => [upload.uploadId, upload.byteSize])) };
}

/**
 * Whether `index` was loaded for every upload `graph` names. A caller judging a graph it did
 * not load the index for — a row that changed between the read and the write — asks this
 * first, and has the author save again rather than be told a picture is missing.
 */
export function uploadIndexCovers(index: UploadIndex, graph: FlowGraph): boolean {
    return [...uploadIdsIn([graph])].every((uploadId) => index.named.has(uploadId));
}

/**
 * What is wrong with the uploaded pictures a graph's messages show, judged against the
 * server the flow belongs to — the upload half of readiness, beside `guildReferenceIssues`.
 *
 * The rules are `messageUploadProblems`', the ones Post Embed's run asks again, each an
 * ordinary readiness issue (stored, never live):
 *
 *  - **An upload must be this server's.** Every read of an upload is scoped to its guild, so
 *    an id copied from another server's flow — or one deleted since — would fail the run.
 *    Addressed to the part: `message.embeds.0.image`.
 *  - **A message may attach at most `MESSAGE_LIMITS.attachments` uploads**, and their bytes
 *    together must fit `MESSAGE_LIMITS.uploadBytes`, each counted once however often it is
 *    shown. Addressed to the message.
 *
 * A field its `visibleWhen` hides is skipped, as every other readiness check skips it.
 *
 * @throws when `index` was not loaded for this graph — a caller's bug, never an author's.
 */
export function uploadReferenceIssues(graph: FlowGraph, index: UploadIndex): readonly FlowValidationIssue[] {
    const issues: FlowValidationIssue[] = [];

    for (const node of graph.nodes) {
        for (const { field, visible } of messageFieldsOf(node)) {
            if (!visible) continue;

            const message = node.data[field.key];
            const unloaded = messageUploadIds(message).find((uploadId) => !index.named.has(uploadId));
            if (unloaded) {
                throw new Error(
                    `The upload index was not loaded for node ${node.id}'s upload ${unloaded}. Load it for every graph being judged.`
                );
            }

            for (const problem of messageUploadProblems(message, index.sizes)) {
                issues.push({ nodeId: node.id, field: [field.key, ...problem.path].join('.'), message: problem.message });
            }
        }
    }

    return issues;
}
