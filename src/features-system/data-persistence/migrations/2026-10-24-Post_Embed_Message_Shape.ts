import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Rewrites every Post Embed node (`action.postEmbed`) from flat keys to one `message`
 * (`docs/plans/message-editor-step-1.md`, "The migration"). The block's schema reads only the
 * new shape, so a node left flat would parse to `{ channelId }` and post nothing.
 *
 * **Where.** `flows.graph` and `flow_drafts.graph` — nothing else holds a node's config:
 * journeys hold no graph, a parked run keeps only ids in its snapshot and runs the live
 * `flows.graph` on resume, and Post Embed cannot park.
 *
 * **Up**, per node that has no `message` yet (so a re-run, or a node the builder already
 * wrote in the new shape, is left alone):
 *
 *   - `title`, `description`, `color` and `url` move into embed 0;
 *   - `authorName` becomes `author.name`, and `footerText` becomes `footer.text`;
 *   - `imageUrl` becomes `image`, and `thumbnailUrl` becomes `thumbnail`;
 *   - `fields` move as they are, each with `inline: false` where it had none — `[]` if absent;
 *   - `showTimestamp: 'true'` becomes `timestamp: true`, anything else `timestamp: false`;
 *   - an empty string is dropped (the new shape says "left out" by absence);
 *   - `channelId`, its `channelIdKey` sidecar and any key this block never had stay at the
 *     top level, untouched.
 *
 * A node with nothing in it at all still gets one embed — holding its colour, if any — so
 * the builder shows it as an empty embed to fill, which is what it was.
 *
 * A value of a shape the old schema would have refused is copied across as it is, never
 * dropped: the new schema then refuses it at the part, and the builder marks it. That
 * includes **links the new rules refuse but the old accepted** — a link with a space in it
 * passed zod's `.url()` and fails the new pattern, and a title link must now also parse as a
 * URL (`https://a%zz/x` fits the pattern and makes discord.js throw). Each is logged with its
 * flow, draft and node and the part it sits in, so an operator can find it; the flow then
 * shows a readiness issue until someone fixes it.
 *
 * **Down** writes embed 0 back to the flat keys and **loses everything the old shape cannot
 * hold**: the plain text, every embed after the first, header and footer icons, and any
 * picture that is an upload. A node whose message has no embed gets no embed keys back.
 *
 * **Runs on the production migrator stack** (`database`): `SqliteJsonPlugin` parses both
 * `graph` columns on sqlite, a bare client hands back strings, and result keys may or may
 * not be camelCased — so both are read either way, and every write is `JSON.stringify`, as
 * `2026-10-10-Owner_Keyed_Resource_Bindings` does. Kysely wraps a postgres migration in a
 * transaction and not a sqlite one, so the sqlite arm opens its own and uses only `trx`.
 *
 * **Frozen.** The block's type, its old keys and the link rules are copied here rather than
 * imported, so this keeps meaning what it meant when it ran.
 *
 * **Deploying.** `dockerEntrypoint.sh` runs migrations before the bot starts. Rolling the
 * code back without running `down` leaves every Post Embed unparseable. A builder tab left
 * open across the deploy still holds the old form and the old graph; every save it sends —
 * a flow save, its draft autosave, its re-check — carrying a flat Post Embed node is
 * refused with "reload the page" (`staleBuilderRefusal` in `src/web/api/staleBuilderGraph.ts`),
 * because storing it would strip the flat keys and erase the embed this carried across.
 * `FLOW_GRAPH_VERSION` stays 1: it is checked on every read of a stored graph, so bumping it
 * would make one row this missed fail its guild's whole flow list.
 */

const POST_EMBED = 'action.postEmbed';

/** The keys Post Embed held its one embed in before it held a message. */
const FLAT_KEYS: ReadonlySet<string> = new Set([
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
]);

/** The new title-link and picture-link rule (`HTTP_LINK_PATTERN`), as it stood. */
const HTTP_LINK = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s/?#]+\S*$/;
/** Any `{{…}}` token, known or not (`COPY_TOKEN_PATTERN`), as it stood. */
const COPY_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/;
/** An upload picture (`upload:<uuid>`), which the flat shape has no way to hold. */
const UPLOAD_REF = /^upload:/;

/** A table holding graphs, and how to name one of its rows in a log line. */
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

type NodeTransform = (data: Record<string, unknown>, where: string) => Record<string, unknown> | null;

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: async (db: Kysely<any>) => {
            await rewriteGraphs(db, toMessageShape);
        },
        down: async (db: Kysely<any>) => {
            await rewriteGraphs(db, toFlatShape);
        },
    },
    sqlite: {
        // `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not wrap
        // this; every row is rewritten or none is.
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await rewriteGraphs(trx, toMessageShape);
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await rewriteGraphs(trx, toFlatShape);
            });
        },
    },
};

/** Every graph in both tables, each Post Embed node through `transform`, written back only if one changed. */
async function rewriteGraphs(db: Kysely<any>, transform: NodeTransform): Promise<void> {
    for (const graphTable of GRAPH_TABLES) {
        const rows: Record<string, unknown>[] = await db.selectFrom(graphTable.table).select([...graphTable.columns]).execute();

        for (const row of rows) {
            const described = graphTable.describe(row);
            const graph = graphObjectOf(columnOf(row, 'graph', 'graph'), described);
            let changed = false;

            const nodes = graph.nodes.map((node: unknown) => {
                if (!isPlainObject(node) || node.type !== POST_EMBED) return node;
                if (!isPlainObject(node.data)) {
                    throw new Error(
                        `The ${described} holds Post Embed node ${String(node.id)} whose data is not an object. Fix the row by hand, then migrate again.`
                    );
                }
                const data = transform(node.data, `${described}, node ${String(node.id)}`);
                if (!data) return node;
                changed = true;
                return { ...node, data };
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

/** A value an author set: present, and not the `''` the old form wrote for a cleared box. */
function isSet(value: unknown): boolean {
    return value !== undefined && value !== '';
}

/**
 * One flat node's data in the new shape, or `null` for a node that already has a `message`.
 * Links the new rules refuse are kept and logged.
 */
function toMessageShape(data: Record<string, unknown>, where: string): Record<string, unknown> | null {
    if ('message' in data) return null;

    const embed: Record<string, unknown> = {};
    const put = (key: string, value: unknown): void => {
        if (isSet(value)) embed[key] = value;
    };

    put('color', data.color);
    if (isSet(data.authorName)) embed.author = { name: data.authorName };
    put('title', data.title);
    put('url', data.url);
    put('description', data.description);
    embed.fields = Array.isArray(data.fields)
        ? data.fields.map((field: unknown) =>
              isPlainObject(field) && field.inline === undefined ? { ...field, inline: false } : field
          )
        : (data.fields ?? []);
    put('thumbnail', data.thumbnailUrl);
    put('image', data.imageUrl);
    if (isSet(data.footerText)) embed.footer = { text: data.footerText };
    embed.timestamp = data.showTimestamp === 'true';

    warnIfRefused(where, 'title link', embed.url, isTitleLink);
    warnIfRefused(where, 'thumbnail', embed.thumbnail, isPicture);
    warnIfRefused(where, 'image', embed.image, isPicture);

    const kept = Object.fromEntries(Object.entries(data).filter(([key]) => !FLAT_KEYS.has(key)));
    return { ...kept, message: { embeds: [embed] } };
}

/**
 * One message-shaped node's data back in the flat shape — embed 0 only, uploads left out —
 * or `null` for a node that is already flat.
 */
function toFlatShape(data: Record<string, unknown>, _where: string): Record<string, unknown> | null {
    if (!('message' in data)) return null;

    const { message, ...kept } = data;
    const embeds = isPlainObject(message) && Array.isArray(message.embeds) ? message.embeds : [];
    const embed: unknown = embeds[0];
    if (!isPlainObject(embed)) return kept;

    const flat: Record<string, unknown> = {};
    const put = (key: string, value: unknown): void => {
        if (value !== undefined) flat[key] = value;
    };
    const notUpload = (value: unknown): unknown =>
        typeof value === 'string' && UPLOAD_REF.test(value) ? undefined : value;

    put('title', embed.title);
    put('description', embed.description);
    put('color', embed.color);
    put('url', embed.url);
    put('authorName', isPlainObject(embed.author) ? embed.author.name : undefined);
    flat.fields = embed.fields ?? [];
    put('imageUrl', notUpload(embed.image));
    put('thumbnailUrl', notUpload(embed.thumbnail));
    put('footerText', isPlainObject(embed.footer) ? embed.footer.text : undefined);
    flat.showTimestamp = embed.timestamp === true ? 'true' : 'false';

    return { ...kept, ...flat };
}

/** The new title-link rule: the link pattern, and a URL that parses (the block's schema asks both). */
function isTitleLink(value: string): boolean {
    return HTTP_LINK.test(value) && URL.canParse(value);
}

/** The new picture rule, for what a flat node can hold: a token, or a link that parses. */
function isPicture(value: string): boolean {
    return COPY_TOKEN.test(value) || (HTTP_LINK.test(value) && URL.canParse(value));
}

/** Log a string the new rules refuse, which is copied across unchanged rather than dropped. */
function warnIfRefused(where: string, part: string, value: unknown, accepted: (value: string) => boolean): void {
    if (typeof value !== 'string' || accepted(value)) return;
    console.warn(
        `[migration] Post Embed in ${where}: its ${part} ${JSON.stringify(value)} is not a link the new message ` +
            'accepts. Copied across unchanged; the builder marks it until someone fixes it.'
    );
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
