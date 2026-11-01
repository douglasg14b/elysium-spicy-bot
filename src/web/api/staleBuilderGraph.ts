import type { z } from '@hono/zod-openapi';
import { ACTION_SEND_MESSAGE } from '../../features/flows/blocks/actionSendMessage';
import { TRIGGER_BUTTON_CLICK } from '../../features/flows/blocks/triggerButtonClick';
import type { FlowGraph } from '../../features/flows/data/flowGraph';
import type { FlowRefusalSchema } from './flowBody';

/**
 * **A bridge for one deploy each**, for the blocks whose config was reshaped under builder
 * tabs that may still be open. Remove an entry once no builder tab can predate its deploy,
 * and the file with the last one.
 *
 *  - **Post Embed**: the `2026-10-24-Post_Embed_Message_Shape` migration rewrote every node
 *    from flat keys (`title`, `imageUrl`, …) to one `message`; then
 *    `2026-10-31-Send_Message_Takes_Post_Embed` turned every one into a Send Message. The
 *    block is gone, so a tab holding one is stale whatever its keys.
 *  - **Send Message**: the same 2026-10-31 migration rewrote its `message` from a string to
 *    the message object Post Embed held.
 *  - **Button Click**: step 3 (`docs/plans/message-resource-step-3.md`) replaced its own
 *    `channelId`, `label` and `style` with one `button` naming a message resource's button.
 *
 * A builder tab left open across such a deploy still holds the old `/api/nodes` descriptor
 * and the old graph, so it saves those nodes in the old shape. Stored as they are, the
 * save's `withDeclaredNodeData` strips the keys the block no longer declares — on a
 * switched-off flow, straight into `flows.graph`, erasing what the migration carried
 * across — and a node of a block that no longer exists is a readiness issue the author can
 * do nothing about. A key the block still declares but holding its old shape — Send Message's
 * string `message` — is not stripped but stored verbatim over the migrated one, where today's
 * editor cannot read it and opens a blank message instead. So a save carrying such a node is
 * refused, with the one thing that fixes it.
 *
 * Each entry says when a node of its block is stale. For a key-renaming reshape: it holds
 * any of the old keys and not the new one. One that holds both is from a stale tab that
 * loaded the migrated graph: its new key is intact, and stripping the old keys loses only
 * that tab's edits to them. A new tab's fresh node holds neither (no block declares a
 * default for its new key), so it is never refused here — nor is a Send Message with no
 * `message` at all, which either tab drops fresh.
 *
 * Not a graph version bump: the version is checked on every read of a stored graph
 * (`validateFlowGraph`), so bumping it would make one row the migration missed fail its
 * guild's whole flow list — a storage invariant to fix a wire problem.
 *
 * The old keys and Post Embed's type are deliberately a second copy of each migration's: a
 * migration is frozen, and this goes when the bridge does.
 */

/** Post Embed's type, as the 2026-10-31 migration froze it. Never a block's constant: the block is gone. */
const POST_EMBED = 'action.postEmbed';

/** Whether a node's data, of the block an entry is keyed by, is what a tab older than its reshape sends. */
type IsStale = (data: FlowGraph['nodes'][number]['data']) => boolean;

/** Stale when the data holds any of `oldKeys` and not `newKey`. */
function renamedKeys(newKey: string, oldKeys: readonly string[]): IsStale {
    return (data) => !Object.hasOwn(data, newKey) && oldKeys.some((key) => Object.hasOwn(data, key));
}

const RESHAPES: Readonly<Record<string, IsStale>> = {
    // Gone: merged into Send Message. Every node of it is from a tab older than the merge.
    [POST_EMBED]: () => true,
    // Its `message` became an object; a string is the old text box's.
    [ACTION_SEND_MESSAGE]: (data) => typeof data.message === 'string',
    [TRIGGER_BUTTON_CLICK]: renamedKeys('button', ['channelId', 'label', 'style']),
};

/** What every save refuses a stale tab's graph with. */
export const STALE_BUILDER_MESSAGE =
    'This builder tab is older than the server, so saving it would wipe your work. Reload the page, then save again.';

/** Whether a node holds its block's old shape. */
function isStale(node: FlowGraph['nodes'][number]): boolean {
    const stale = Object.hasOwn(RESHAPES, node.type) ? RESHAPES[node.type] : undefined;
    return stale ? stale(node.data) : false;
}

/**
 * The 400 a save answers when `graph` came from a builder tab older than a block's reshape,
 * or `undefined` when it did not. Ask it before `withDeclaredNodeData`, which would strip the
 * evidence, and before anything judges the nodes against today's blocks.
 */
export function staleBuilderRefusal(graph: FlowGraph): z.infer<typeof FlowRefusalSchema> | undefined {
    const stale = graph.nodes.find(isStale);
    if (!stale) return undefined;
    return { error: STALE_BUILDER_MESSAGE, issues: [{ nodeId: stale.id, message: STALE_BUILDER_MESSAGE }] };
}
