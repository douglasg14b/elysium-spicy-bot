import type { z } from '@hono/zod-openapi';
import { ACTION_POST_EMBED } from '../../features/flows/blocks/actionPostEmbed';
import { TRIGGER_BUTTON_CLICK } from '../../features/flows/blocks/triggerButtonClick';
import type { FlowGraph } from '../../features/flows/data/flowGraph';
import type { FlowRefusalSchema } from './flowBody';

/**
 * **A bridge for one deploy each**, for the blocks whose config was reshaped under builder
 * tabs that may still be open. Remove an entry once no builder tab can predate its deploy,
 * and the file with the last one.
 *
 *  - **Post Embed**: the `2026-10-24-Post_Embed_Message_Shape` migration rewrote every node
 *    from flat keys (`title`, `imageUrl`, …) to one `message`.
 *  - **Button Click**: step 3 (`docs/plans/message-resource-step-3.md`) replaced its own
 *    `channelId`, `label` and `style` with one `button` naming a message resource's button.
 *
 * A builder tab left open across such a deploy still holds the old `/api/nodes` descriptor
 * and the old graph, so it saves those nodes in the old shape. Stored as they are, the
 * save's `withDeclaredNodeData` strips the keys the block no longer declares — on a
 * switched-off flow, straight into `flows.graph`, erasing what the migration carried
 * across. So a save carrying such a node is refused, with the one thing that fixes it.
 *
 * A node is stale when it holds any of its block's old keys and not the new one. One that
 * holds both is from a stale tab that loaded the migrated graph: its new key is intact, and
 * stripping the old keys loses only that tab's edits to them. A new tab's fresh node holds
 * neither (neither block declares a default for its new key), so it is never refused here.
 *
 * Not a graph version bump: the version is checked on every read of a stored graph
 * (`validateFlowGraph`), so bumping it would make one row the migration missed fail its
 * guild's whole flow list — a storage invariant to fix a wire problem.
 *
 * The old keys are deliberately a second copy of each migration's: a migration is frozen,
 * and this goes when the bridge does.
 */

/** A reshaped block's key now, and the keys a tab older than the reshape still sends. */
interface Reshape {
    readonly newKey: string;
    readonly oldKeys: readonly string[];
}

const RESHAPES: Readonly<Record<string, Reshape>> = {
    [ACTION_POST_EMBED]: {
        newKey: 'message',
        oldKeys: [
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
        ],
    },
    [TRIGGER_BUTTON_CLICK]: {
        newKey: 'button',
        oldKeys: ['channelId', 'label', 'style'],
    },
};

/** What every save refuses a stale tab's graph with. */
export const STALE_BUILDER_MESSAGE =
    'This builder tab is older than the server, so saving it would wipe your work. Reload the page, then save again.';

/** Whether a node holds its block's old shape and not the new one. */
function isStale(node: FlowGraph['nodes'][number]): boolean {
    const reshape = Object.hasOwn(RESHAPES, node.type) ? RESHAPES[node.type] : undefined;
    if (!reshape) return false;
    return (
        !Object.hasOwn(node.data, reshape.newKey) && reshape.oldKeys.some((key) => Object.hasOwn(node.data, key))
    );
}

/**
 * The 400 a save answers when `graph` came from a builder tab older than a block's reshape,
 * or `undefined` when it did not. Ask it before `withDeclaredNodeData`, which would strip the
 * evidence.
 */
export function staleBuilderRefusal(graph: FlowGraph): z.infer<typeof FlowRefusalSchema> | undefined {
    const stale = graph.nodes.find(isStale);
    if (!stale) return undefined;
    return { error: STALE_BUILDER_MESSAGE, issues: [{ nodeId: stale.id, message: STALE_BUILDER_MESSAGE }] };
}
