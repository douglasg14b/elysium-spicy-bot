import type { z } from '@hono/zod-openapi';
import { ACTION_POST_EMBED } from '../../features/flows/blocks/actionPostEmbed';
import type { FlowGraph } from '../../features/flows/data/flowGraph';
import type { FlowRefusalSchema } from './flowBody';

/**
 * **A bridge for one deploy**: the `2026-10-24-Post_Embed_Message_Shape` migration, which
 * rewrote every Post Embed node from flat keys (`title`, `imageUrl`, …) to one `message`.
 * Remove it once no builder tab can predate that deploy.
 *
 * A builder tab left open across the deploy still holds the old `/api/nodes` descriptor and
 * the old graph, so it saves Post Embed nodes in the flat shape. Stored as they are, the
 * save's `withDeclaredNodeData` strips the keys the block no longer declares, leaving
 * `{ channelId }` — on a switched-off flow, straight into `flows.graph`, erasing the embed the
 * migration carried across. So a save carrying such a node is refused, with the one thing
 * that fixes it.
 *
 * A node is flat when it holds any of the old keys and no `message`. One that holds both is
 * from a stale tab that loaded the migrated graph: its `message` is intact, and stripping the
 * flat keys loses only that tab's edits to them. A new tab's fresh Post Embed holds neither
 * (Post Embed declares no default message), so it is never refused here.
 *
 * Not a graph version bump: the version is checked on every read of a stored graph
 * (`validateFlowGraph`), so bumping it would make one row the migration missed fail its
 * guild's whole flow list — a storage invariant to fix a wire problem.
 *
 * `FLAT_KEYS` is deliberately a second copy of the migration's: that one is frozen, and this
 * one goes when the bridge does.
 */

const FLAT_KEYS: readonly string[] = [
    'title',
    'description',
    'color',
    'url',
    'authorName',
    'fields',
    'imageUrl',
    'thumbnailUrl',
    'footerText',
    'showTimestamp',
];

/** What every save refuses a stale tab's graph with. */
export const STALE_BUILDER_MESSAGE =
    'This builder tab is older than the Post Embed editor, so saving it would wipe your embeds. Reload the page, then save again.';

/**
 * The 400 a save answers when `graph` came from a builder tab older than the Post Embed
 * reshape, or `undefined` when it did not. Ask it before `withDeclaredNodeData`, which would
 * strip the evidence.
 */
export function staleBuilderRefusal(graph: FlowGraph): z.infer<typeof FlowRefusalSchema> | undefined {
    const stale = graph.nodes.find(
        (node) =>
            node.type === ACTION_POST_EMBED &&
            !Object.hasOwn(node.data, 'message') &&
            FLAT_KEYS.some((key) => Object.hasOwn(node.data, key))
    );
    if (!stale) return undefined;
    return { error: STALE_BUILDER_MESSAGE, issues: [{ nodeId: stale.id, message: STALE_BUILDER_MESSAGE }] };
}
