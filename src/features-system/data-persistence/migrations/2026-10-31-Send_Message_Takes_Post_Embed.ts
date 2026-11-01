import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Send Message takes over Post Embed (`docs/plans/send-message-merge.md`, "The migration"):
 * one block posts plain text, embeds, or both, with buttons. Send Message's schema now reads
 * Post Embed's message object, and Post Embed is gone.
 *
 * **Where.** `flows.graph` and `flow_drafts.graph` — nothing else holds a node's config:
 * journeys hold no graph, a parked run keeps only ids in its snapshot and runs the live
 * `flows.graph` on resume, and neither block can park. Node ids do not change, so
 * `flow_posted_messages` and a Button Click's `{ flowId, nodeId, buttonKey }` keep naming the
 * same posts.
 *
 * **Up**, per node:
 *
 *   - `action.postEmbed` becomes `action.sendMessage`, its data untouched (`where`,
 *     `channelId` and its sidecar, `message`, `buttons` mean the same on both);
 *   - an `action.sendMessage` whose `message` is a string gets `{ content: <string>, embeds: [] }`.
 *     An empty string is dropped — the message shape says "left out" by absence — so the node
 *     holds `{ embeds: [] }`, a message with neither, which the schema names for the builder
 *     to mark, as the old schema refused the empty string;
 *   - a Send Message whose `message` is already an object, or absent, is left alone — so a
 *     re-run, or a node the builder already wrote in the new shape, changes nothing.
 *
 * **Down** is lossy. A Send Message whose message is plain text only — no embeds, no buttons
 * — gets its string back (`{ embeds: [] }` gets `''`). Any other becomes `action.postEmbed`
 * and loses `ephemeral`, which Post Embed never had: a private answer with an embed goes back
 * to being posted in the channel. A Post Embed that held only plain text and no buttons
 * comes back as a Send Message — the two cannot be told apart once merged.
 *
 * **Runs on the production migrator stack** (`database`): `SqliteJsonPlugin` parses both
 * `graph` columns on sqlite, a bare client hands back strings, and result keys may or may
 * not be camelCased — so both are read either way, and every write is `JSON.stringify`, as
 * `2026-10-24-Post_Embed_Message_Shape` does. Kysely wraps a postgres migration in a
 * transaction and not a sqlite one, so the sqlite arm opens its own and uses only `trx`.
 *
 * **Frozen.** Both block types are copied here rather than imported, so this keeps meaning
 * what it meant when it ran.
 *
 * **Deploying.** `dockerEntrypoint.sh` runs migrations before the bot starts. Rolling the
 * code back without running `down` leaves every Send Message unparseable and every former
 * Post Embed an unknown block. A builder tab left open across the deploy still holds the old
 * palette and the old graph; every save it sends carrying a Post Embed, or a Send Message
 * whose message is a string, is refused with "reload the page" (`staleBuilderRefusal` in
 * `src/web/api/staleBuilderGraph.ts`). `FLOW_GRAPH_VERSION` stays 1: it is checked on every
 * read of a stored graph, so bumping it would make one row this missed fail its guild's
 * whole flow list.
 */

const POST_EMBED = 'action.postEmbed';
const SEND_MESSAGE = 'action.sendMessage';

/** A table holding graphs, and how to name one of its rows in an error. */
interface GraphTable {
    readonly table: 'flows' | 'flow_drafts';
    readonly columns: readonly string[];
    readonly keyColumn: 'flow_id' | 'id';
    readonly describe: (row: Record<string, unknown>) => string;
}

const GRAPH_TABLES: readonly GraphTable[] = [
    {
        table: 'flows',
        columns: ['flow_id', 'graph'],
        keyColumn: 'flow_id',
        describe: (row) => `flow ${String(columnOf(row, 'flow_id', 'flowId'))}`,
    },
    {
        table: 'flow_drafts',
        columns: ['id', 'flow_id', 'graph'],
        keyColumn: 'id',
        describe: (row) => `flow ${String(columnOf(row, 'flow_id', 'flowId'))} draft ${String(columnOf(row, 'id', 'id'))}`,
    },
];

/** A node as stored: its type and data, the rest of it carried as it is. */
interface StoredNode extends Record<string, unknown> {
    readonly type: string;
    readonly data: Record<string, unknown>;
}

/** One node rewritten, or `null` for a node this direction leaves alone. */
type NodeTransform = (node: StoredNode) => StoredNode | null;

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: async (db: Kysely<any>) => {
            await rewriteGraphs(db, toSendMessage);
        },
        down: async (db: Kysely<any>) => {
            await rewriteGraphs(db, toSplitBlocks);
        },
    },
    sqlite: {
        // `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not wrap
        // this; every row is rewritten or none is.
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await rewriteGraphs(trx, toSendMessage);
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await rewriteGraphs(trx, toSplitBlocks);
            });
        },
    },
};

/** Every graph in both tables, each Post Embed and Send Message node through `transform`, written back only if one changed. */
async function rewriteGraphs(db: Kysely<any>, transform: NodeTransform): Promise<void> {
    for (const graphTable of GRAPH_TABLES) {
        const rows: Record<string, unknown>[] = await db.selectFrom(graphTable.table).select([...graphTable.columns]).execute();

        for (const row of rows) {
            const described = graphTable.describe(row);
            const graph = graphObjectOf(columnOf(row, 'graph', 'graph'), described);
            let changed = false;

            const nodes = graph.nodes.map((node: unknown) => {
                if (!isPlainObject(node) || (node.type !== POST_EMBED && node.type !== SEND_MESSAGE)) return node;
                if (!isPlainObject(node.data)) {
                    throw new Error(
                        `The ${described} holds ${String(node.type)} node ${String(node.id)} whose data is not an object. Fix the row by hand, then migrate again.`
                    );
                }
                const rewritten = transform({ ...node, type: node.type, data: node.data });
                if (!rewritten) return node;
                changed = true;
                return rewritten;
            });

            if (!changed) continue;
            const key = columnOf(row, graphTable.keyColumn, graphTable.keyColumn === 'flow_id' ? 'flowId' : 'id');
            await db
                .updateTable(graphTable.table)
                .set({ graph: JSON.stringify({ ...graph, nodes }) })
                .where(graphTable.keyColumn, '=', key)
                .execute();
        }
    }
}

/**
 * Up: a Post Embed becomes a Send Message as it is; a string message becomes an object. The
 * string step asks both types, so a Post Embed that somehow held a string — nothing ever wrote
 * one — does not land as a Send Message every save of which the stale-tab bridge refuses.
 */
function toSendMessage(node: StoredNode): StoredNode | null {
    const renamed = node.type === POST_EMBED;
    const { message } = node.data;
    if (typeof message !== 'string') return renamed ? { ...node, type: SEND_MESSAGE } : null;
    return {
        ...node,
        type: SEND_MESSAGE,
        data: { ...node.data, message: message === '' ? { embeds: [] } : { content: message, embeds: [] } },
    };
}

/**
 * Down: a Send Message holding plain text alone gets its string back; any other holding a
 * message object becomes a Post Embed, without `ephemeral`. A Post Embed (none should exist
 * after `up`) and a Send Message whose message is already a string, or absent, are left alone.
 */
function toSplitBlocks(node: StoredNode): StoredNode | null {
    if (node.type !== SEND_MESSAGE) return null;
    const { message } = node.data;
    if (!isPlainObject(message)) return null;

    const embeds = Array.isArray(message.embeds) ? message.embeds : [];
    const buttons = Array.isArray(node.data.buttons) ? node.data.buttons : [];
    const contentOnly =
        embeds.length === 0 &&
        buttons.length === 0 &&
        Object.keys(message).every((key) => key === 'content' || key === 'embeds') &&
        (message.content === undefined || typeof message.content === 'string');
    if (contentOnly) {
        const { buttons: _noButtons, ...kept } = node.data;
        return { ...node, data: { ...kept, message: typeof message.content === 'string' ? message.content : '' } };
    }

    const { ephemeral: _dropped, ...kept } = node.data;
    return { ...node, type: POST_EMBED, data: kept };
}

/** A result column, whether or not `CamelCasePlugin` renamed it. */
function columnOf(row: Record<string, unknown>, snake: string, camel: string): unknown {
    return snake in row ? row[snake] : row[camel];
}

/** `graph` as an object with a node list: parsed by the production stack, a string through a bare client. */
function graphObjectOf(raw: unknown, described: string): Record<string, unknown> & { nodes: unknown[] } {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isPlainObject(parsed) || !Array.isArray(parsed.nodes)) {
        throw new Error(`The ${described} holds a graph that is not an object with a node list. Fix the row by hand, then migrate again.`);
    }
    return parsed as Record<string, unknown> & { nodes: unknown[] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
