import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Turns every Button Click trigger that owned a button (`{ channelId, label, style }`, posted
 * by the retired Deploy as `flow:<flowId>:<nodeId>`) into one that listens to a button of a
 * message its journey declares (`{ button: { messageKey, buttonKey } }`) —
 * `docs/plans/message-resource-step-3.md`, "The changeover", as amended by Douglas's answers
 * of 2026-10-25.
 *
 * **The posted rows decide, not the nodes.** A node is "waiting" while it is a Button Click
 * with no `button` and at least one old key. For each flow with waiting nodes, its
 * `flow_button_messages` rows are read newest first; in each channel, the newest row naming
 * a waiting node is the **posted message**, and its `channel_id` is where the message is —
 * the node's own `channelId` is never consulted (review items 9 and 24).
 *
 *  - A waiting node no row names was **never posted** (or posted before the table existed):
 *    it loses its old keys, gets no `button`, and is logged. Nothing is declared for it, and
 *    a button posted for it before the table existed answers through the `flow:` bridge that
 *    it is retired.
 *  - Every row not adopted is logged with its reason — an older post in a channel that has a
 *    newer one, a row whose flow is gone, a row naming no waiting node — as a message to
 *    delete by hand. The `flow:` bridge keeps its buttons answering until it goes. A row that
 *    is adopted but also names nodes that are no longer waiting is logged too: their buttons
 *    are not on the message it becomes, so Repair takes them off.
 *
 * **Which journey.** Flows with a posted message are grouped, transitively: two are in one
 * group when they posted into a common channel or already share a journey (a link row, or
 * the pre-link fallback — a journey keyed by the flow's own id — exactly as
 * `resolveFlowJourney` reads it). A journey holding a settled text-channel binding on a
 * channel a flow posted into is one of that flow's journeys too, though none of its flows
 * posted there: linking to it reuses the binding, where a journey of the group's own would
 * adopt a channel another holds, and Install would refuse it. A group with no journey gets
 * one, keyed by its oldest flow's id (`flows.id`, which is monotonic on both dialects),
 * named after that flow and `created_for_flow_id` it; a group with one journey uses it; a
 * group with two or more merges nothing — bindings cannot move — and is logged as a hazard
 * naming the journeys and the channels: each flow in a journey keeps it, and a flow in none
 * joins the journey of a channel it shares (the journey holding it, else the oldest flow
 * posting there that has one) rather than adding one more journey to that channel. Every
 * member is linked to its journey, the fallback's own flow included.
 *
 * **What each journey gains.**
 *
 *  - **One text channel per destination**, declared once: a channel this journey has bound
 *    there under a declared key; else the key a node's `channelIdKey` sidecar names, if it
 *    adopts or is bound to the destination; else a declared channel adopting it; else a
 *    binding of this journey to it whose key is no longer declared, re-declared under that
 *    key (review item 23 — install then reuses the binding); else a new declaration
 *    adopting it by id, named as any binding in the guild names that channel, or
 *    "<flow name> channel". A channel some other owner already holds is logged. A key this
 *    journey installed as a *different* channel is never picked, though its declaration
 *    adopts the destination — a message under it would be in the wrong channel — and since a
 *    second declaration cannot adopt the same channel, that post is not adopted: logged, its
 *    triggers emptied.
 *  - **One message per posted message**, one-to-one with what was posted: named after the
 *    flow, holding exactly what Deploy posted (`**<flow name>**`, no embeds), parented on
 *    that channel, with one button per waiting node the row names, in the row's order (the
 *    graph's order when it was posted) — keyed by its label's slug, its label and style as
 *    the node holds them now.
 *  - **A `message` binding for it**: `created` (the bot posted it, so uninstall deletes it),
 *    `discord_id` the message, `message_channel_id` its channel, and `message_digest`
 *    **null**, so drift reads it as out of date (`journeyDriftPlan.ts`'s `checkMessage`
 *    compares the digest, and install's `reuse` never writes one).
 *
 * **The nodes.** A posted node becomes `{ button: { messageKey, buttonKey }, …rest }` with
 * its four old keys (`channelId`, `channelIdKey`, `label`, `style`) gone and everything
 * else — its gate above all — untouched. A node posted into two channels listens to the
 * newer message. Every draft of the flow gets the same mapping; a draft node whose old keys
 * differ from the live node's is logged (its edit is dropped), and a waiting node that
 * exists only in a draft, or was never posted, is emptied and logged.
 *
 * **The rules a journey is read and saved under** are copied here, frozen: keys match
 * `^[a-z0-9]+(-[a-z0-9]+)*$` in at most 64 characters, with a fallback when a name slugs to
 * nothing; a name is at most 100 characters, and a text channel's is stored as Discord
 * holds it (lowercase, whitespace hyphenated); a label is 1–80 characters; at most 100
 * resources and 25 buttons; and no `{{`/`}}` in a message's name, text or labels, since a
 * posted message refuses tokens — they are stripped, and logged. A new key steps over every
 * key the journey declares **and** every key it holds a binding under, since bindings
 * outlive declarations. What this writes is checked against the frozen copy before it is
 * written, and the migration throws rather than store a journey that would fail every read.
 *
 * **The version.** `journeys.updated_at` is the resource version a dashboard tab saves
 * against (`journeysRepo.updateAtVersion`), so every journey row this writes moves it on —
 * by a millisecond at least — and a tab left open across the deploy is told to reload.
 * A journey whose resources come out unchanged is not written, and keeps its version.
 *
 * **Idempotent.** A node that already has `button` is never waiting, a message already
 * bound is reused rather than bound twice, a key already declared is reused, and a message
 * this migration declared is recognised again (by its binding, else by its channel and
 * name) — so a second run writes nothing, and `down` then `up` lands where the first `up` did.
 *
 * **The log is the record**: production runs this once, with no backup or dry run. One
 * summary per guild names every journey written, every flow linked, every channel and how
 * it was found, and every message adopted with its buttons; every skip and hazard is a
 * warning of its own, with its reason. Nothing is printed until the last guild is written,
 * so a throw — which rolls every guild back — leaves no "converted" line behind it.
 *
 * **Down** writes each converted node back to `{ channelId, label, style }` from its
 * journey: the label and style off the button, the channel off the parent's adopted id or
 * binding — else `channelId: ''` with the parent's key as `channelIdKey`. A node naming a
 * button its journey does not declare (one authored after the deploy, say) is left as it
 * is, logged: there is no label to give it, and step 2 reads it as unfinished. It deletes the
 * `message` bindings this created, found by the message ids in `flow_button_messages`, and
 * leaves every declaration, journey and link, which step 2's code reads fine. **Lost on
 * down**: the old keys of every node `up` emptied (never posted, draft-only), a label or
 * name `up` stripped or shortened, and any button edited since. **After a down, never
 * Install or Repair a converted journey on step 2's code**: with no binding, install posts
 * the message a second time.
 *
 * **Runs on the production migrator stack** (`database`): `CamelCasePlugin` on both
 * dialects and, on SQLite, `SqliteJsonPlugin` and `SqlDatePlugin` — so result keys may be
 * camelCased or not, JSON columns (`graph`, `resources`, `node_ids`) may arrive parsed or
 * as strings, and dates as `Date`s or strings; each is read either way, and every JSON
 * write is `JSON.stringify`, which Postgres casts back into `jsonb`. Kysely wraps a
 * Postgres migration in a transaction and not a SQLite one, so the SQLite arm opens its own
 * and uses only `trx` — a query on `db` would wait on the connection it holds. Both arms
 * run the same steps against the same named tables and columns.
 *
 * **Deploying.** After this runs, each converted journey goes Install (adopts the channel;
 * the message is a `reuse`, so nothing is posted) → Drift (the message is out of date) →
 * Repair (edits it in place to `mbtn:` buttons, keeping its id and its place). Until then
 * its `flow:` buttons answer through the bridge in `initFlows`.
 */

const TRIGGER_BUTTON_CLICK = 'trigger.buttonClick';

/** The keys a Button Click held its own button in: its channel, that channel's sidecar, its label and style. */
const OLD_KEYS: readonly string[] = ['channelId', 'channelIdKey', 'label', 'style'];

/** The resource key rule (`src/shared/resourceKey.ts`), as it stood. */
const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY_MAX_LENGTH = 64;

/** A resource's name and a journey's name (`journeyBody.ts`), as they stood. */
const NAME_MAX_LENGTH = 100;

/** A button's label, Discord's limit. */
const LABEL_MAX_LENGTH = 80;

/** A message's plain text, Discord's limit. */
const CONTENT_MAX_LENGTH = 2000;

/** The most resources one journey may declare (`JOURNEY_MAX_RESOURCES`), as it stood. */
const MAX_RESOURCES = 100;

/** The most buttons one message carries: five rows of five. */
const MAX_BUTTONS = 25;

/** The styles a message's button may take; the old schema's default was the first. */
const BUTTON_STYLES: readonly string[] = ['Primary', 'Secondary', 'Success', 'Danger'];
const DEFAULT_STYLE = 'Primary';

/** What a name or label becomes when stripping it, or slugging it, leaves nothing. */
const FALLBACK = {
    journeyName: 'Buttons',
    messageName: 'Button message',
    label: 'Button',
    messageKey: 'message',
    channelKey: 'channel',
    buttonKey: 'button',
} as const;

const LOG_PREFIX = '[migration] Button Click → message';

/**
 * What the `flow:` bridge answers for a node this empties (`RETIRED_BUTTON_MESSAGE`,
 * `engine/flowTriggerDispatch.ts`), copied rather than imported, for the log.
 */
const RETIRED_BUTTON_ANSWER = "This button's been retired — ask a mod to repost it.";

type JsonObject = Record<string, unknown>;
type Graph = JsonObject & { nodes: unknown[] };
type GraphNode = JsonObject & { id: string; data: JsonObject };

interface FlowRow {
    readonly id: number;
    readonly flowId: string;
    readonly name: string;
    readonly graph: Graph;
}

interface DraftRow {
    readonly id: number;
    readonly flowId: string;
    readonly graph: Graph;
}

/** A journey as this run holds it: read, or made by this run, and written at the end if it changed. */
interface JourneyState {
    readonly journeyKey: string;
    readonly name: string;
    readonly createdForFlowId: string | null;
    /** `updated_at` in milliseconds, or `null` for a journey this run creates. */
    readonly updatedAtMs: number | null;
    /** The stored list, serialised, to tell whether anything changed. */
    readonly storedResources: string | null;
    readonly resources: JsonObject[];
}

interface BindingRow {
    readonly ownerKind: string;
    readonly ownerKey: string;
    readonly resourceKey: string;
    readonly kind: string;
    readonly state: string;
    readonly discordId: string | null;
    readonly name: string;
}

interface PostRow {
    readonly id: number;
    readonly flowId: string;
    readonly channelId: string;
    readonly messageId: string;
    readonly nodeIds: readonly string[];
}

/** Everything one guild holds that this reads. */
interface GuildSnapshot {
    readonly guildId: string;
    /** In `flows.id` order: oldest first. */
    readonly flows: readonly FlowRow[];
    readonly drafts: readonly DraftRow[];
    readonly journeys: Map<string, JourneyState>;
    /** Flow id → the journey key its link row names. */
    readonly links: ReadonlyMap<string, string>;
    readonly bindings: readonly BindingRow[];
    /** In `flow_button_messages.id` order: oldest first. */
    readonly posts: readonly PostRow[];
}

/** A button a converted node names. */
interface ButtonRef {
    readonly messageKey: string;
    readonly buttonKey: string;
}

/** What one guild's pass decided to write. */
interface GuildWrites {
    readonly flowGraphs: Map<string, Graph>;
    readonly draftGraphs: Map<number, Graph>;
    /** Flow id → the journey it must be linked to, where its link says otherwise or is missing. */
    readonly links: Map<string, string>;
    readonly bindings: NewMessageBinding[];
}

interface NewMessageBinding {
    readonly journeyKey: string;
    readonly resourceKey: string;
    readonly messageId: string;
    readonly channelId: string;
    readonly name: string;
}

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: async (db: Kysely<any>) => {
            await migrateUp(db);
        },
        down: async (db: Kysely<any>) => {
            await migrateDown(db);
        },
    },
    sqlite: {
        // `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not wrap
        // this; every guild is converted or none is.
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await migrateUp(trx);
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await migrateDown(trx);
            });
        },
    },
};

// ---------------------------------------------------------------------------------------
// Up
// ---------------------------------------------------------------------------------------

async function migrateUp(db: Kysely<any>): Promise<void> {
    const log: LogLine[] = [];
    for (const snapshot of await readGuilds(db)) {
        const writes = convertGuild(snapshot, log);
        await writeGuild(db, snapshot, writes);
    }
    printLog(log);
}

/** One line of the record, held until every guild is written: see {@link printLog}. */
interface LogLine {
    readonly level: 'warn' | 'log';
    readonly text: string;
}

/**
 * Print the record, in guild order — only once the last guild is written. A throw part-way
 * rolls every guild back, and printing as it went would leave earlier guilds' "converted"
 * summaries in the log for writes that never happened; the throw's own message names its
 * guild. As late as this file can make it: the migrator commits after `up` returns.
 */
function printLog(log: readonly LogLine[]): void {
    for (const line of log) {
        if (line.level === 'warn') console.warn(line.text);
        else console.log(line.text);
    }
}

/**
 * One guild's conversion, decided in memory: what to write, and every log line, appended to
 * `log`. Nothing is written until the whole guild has been decided, so a throw part-way
 * writes nothing.
 */
function convertGuild(snapshot: GuildSnapshot, log: LogLine[]): GuildWrites {
    const { guildId } = snapshot;
    const warn = (line: string): void => {
        log.push({ level: 'warn', text: `${LOG_PREFIX}, guild ${guildId}: ${line}` });
    };
    const writes: GuildWrites = { flowGraphs: new Map(), draftGraphs: new Map(), links: new Map(), bindings: [] };

    const flowsById = new Map(snapshot.flows.map((flow) => [flow.flowId, flow]));
    const waitingByFlow = new Map<string, Map<string, GraphNode>>();
    for (const flow of snapshot.flows) {
        const waiting = new Map(waitingNodesOf(flow.graph).map((node) => [node.id, node]));
        if (waiting.size > 0) waitingByFlow.set(flow.flowId, waiting);
    }
    const boundMessageIds = new Set(
        snapshot.bindings.filter((binding) => binding.kind === 'message' && binding.discordId).map((binding) => binding.discordId)
    );

    // --- Which rows are posted messages: per flow and channel, the newest naming a waiting node.
    const postedByFlow = new Map<string, Map<string, PostRow>>();
    const postOfNode = new Map<string, PostRow>();
    for (const post of [...snapshot.posts].reverse()) {
        const where = `flow_button_messages row ${post.id} (message ${post.messageId} in channel ${post.channelId})`;
        const flow = flowsById.get(post.flowId);
        if (!flow) {
            warn(`${where} belongs to flow ${post.flowId}, which is gone from this server. Not adopted — delete the message by hand.`);
            continue;
        }
        const waiting = waitingByFlow.get(flow.flowId);
        const named = post.nodeIds.filter((nodeId) => waiting?.has(nodeId));
        if (named.length === 0) {
            // A message already bound is one a run before this one adopted: nothing to say.
            if (!boundMessageIds.has(post.messageId)) {
                warn(
                    `${where} of ${describeFlow(flow)} names no Button Click still in its old shape ` +
                        `(${post.nodeIds.join(', ') || 'no nodes'}). Not adopted — delete the message by hand.`
                );
            }
            continue;
        }

        const byChannel = postedByFlow.get(flow.flowId) ?? new Map<string, PostRow>();
        const newer = byChannel.get(post.channelId);
        if (newer) {
            warn(
                `${where} of ${describeFlow(flow)} is an older post in a channel where row ${newer.id} ` +
                    `(message ${newer.messageId}) is newer. Not adopted — delete it by hand.`
            );
            continue;
        }
        byChannel.set(post.channelId, post);
        postedByFlow.set(flow.flowId, byChannel);

        const dropped = post.nodeIds.filter((nodeId) => !waiting?.has(nodeId));
        if (dropped.length > 0) {
            warn(
                `${where} of ${describeFlow(flow)} also names ${dropped.join(', ')}, no longer a Button Click in its old ` +
                    'shape in this flow. Their buttons are left off the message it is adopted as, so Repair takes them off ' +
                    'the posted message.'
            );
        }

        for (const nodeId of named) {
            const nodeKey = `${flow.flowId}:${nodeId}`;
            const listened = postOfNode.get(nodeKey);
            if (listened) {
                warn(
                    `node ${nodeId} of ${describeFlow(flow)} is on message ${post.messageId} in channel ${post.channelId} ` +
                        `as well as the newer message ${listened.messageId} in channel ${listened.channelId}. Its trigger ` +
                        'listens to the newer; the older copy of its button answers nobody once that message is repaired.'
                );
                continue;
            }
            postOfNode.set(nodeKey, post);
        }
    }

    // --- Never posted: emptied, and nothing declared for it.
    for (const [flowId, waiting] of waitingByFlow) {
        const flow = flowsById.get(flowId) as FlowRow;
        for (const nodeId of waiting.keys()) {
            if (postOfNode.has(`${flowId}:${nodeId}`)) continue;
            warn(
                `node ${nodeId} of ${describeFlow(flow)} was never posted — no flow_button_messages row names it. ` +
                    'Emptied, and no channel or message declared for it; the builder says "Fill this in". Any button ' +
                    `Deploy posted for it before that table existed now answers "${RETIRED_BUTTON_ANSWER}" — delete ` +
                    'that message by hand.'
            );
        }
    }

    // --- Which journey each flow with a posted message lands in.
    const postingFlows = snapshot.flows.filter((flow) => postedByFlow.has(flow.flowId));
    const journeyOfFlow = assignJourneys(snapshot, postingFlows, postedByFlow, writes, warn);

    // --- What each journey gains: channels, messages and their bindings.
    const summary = new Map<string, string[]>();
    const nodeButtons = new Map<string, ButtonRef>();
    const claimedMessages = new Set<string>();
    const channelKeys = new Map<string, ReturnType<typeof declareChannel>>();
    for (const flow of postingFlows) {
        const journeyKey = journeyOfFlow.get(flow.flowId) as string;
        const journey = snapshot.journeys.get(journeyKey) as JourneyState;
        const lines = summary.get(journeyKey) ?? [];
        summary.set(journeyKey, lines);
        const waiting = waitingByFlow.get(flow.flowId) as Map<string, GraphNode>;
        const posts = [...(postedByFlow.get(flow.flowId) as Map<string, PostRow>).values()].sort((left, right) => left.id - right.id);

        for (const post of posts) {
            const postedNodes = post.nodeIds.flatMap((nodeId) => {
                const node = waiting.get(nodeId);
                return node ? [node] : [];
            });
            if (postedNodes.length > MAX_BUTTONS) {
                throw new Error(
                    `${LOG_PREFIX}: flow_button_messages row ${post.id} in guild ${guildId} names ${postedNodes.length} buttons, ` +
                        `and a message holds ${MAX_BUTTONS}. Deploy never posted that; fix the row by hand, then migrate again.`
                );
            }

            const channelMemo = `${journeyKey}\u0000${post.channelId}`;
            let channel = channelKeys.get(channelMemo);
            if (!channel) {
                channel = declareChannel(snapshot, journey, post.channelId, postedNodes, flow, warn);
                channelKeys.set(channelMemo, channel);
                if ('key' in channel) lines.push(`    channel "${channel.key}" → ${post.channelId} (${channel.how})`);
            }
            if ('refused' in channel) {
                // The nodes listening to this message, which is the newest they were posted in.
                const emptied = postedNodes.filter((node) => postOfNode.get(`${flow.flowId}:${node.id}`) === post);
                warn(
                    `flow_button_messages row ${post.id} (message ${post.messageId} in channel ${post.channelId}) of ` +
                        `${describeFlow(flow)} can't be adopted: ${channel.refused}. Not adopted — fix the declaration, ` +
                        'then delete the message by hand.' +
                        (emptied.length > 0
                            ? ` Its triggers ${emptied.map((node) => node.id).join(', ')} are emptied, and their buttons ` +
                              `now answer "${RETIRED_BUTTON_ANSWER}".`
                            : '')
                );
                continue;
            }
            const channelKey = channel.key;

            const message = declareMessage({ snapshot, journey, flow, post, channelKey, postedNodes, claimedMessages, warn });
            if (message.newBinding) {
                writes.bindings.push({
                    journeyKey,
                    resourceKey: message.key,
                    messageId: post.messageId,
                    channelId: post.channelId,
                    name: message.name,
                });
            }
            const buttonList = message.buttons
                .map((button) => `${button.buttonKey} ← node ${button.nodeId}`)
                .join(', ');
            lines.push(
                `    message "${message.key}" ("${message.name}", ${describeFlow(flow)}) → message ${post.messageId} in ` +
                    `channel ${post.channelId}${message.newBinding ? '' : ', already bound'}: ${buttonList}`
            );

            for (const button of message.buttons) {
                if (postOfNode.get(`${flow.flowId}:${button.nodeId}`) !== post) continue;
                nodeButtons.set(`${flow.flowId}:${button.nodeId}`, { messageKey: message.key, buttonKey: button.buttonKey });
            }
        }
    }

    // --- The nodes, live and drafted.
    for (const [flowId, waiting] of waitingByFlow) {
        const flow = flowsById.get(flowId) as FlowRow;
        writes.flowGraphs.set(
            flowId,
            rewriteGraph(flow.graph, (node) => (waiting.has(node.id) ? converted(node.data, nodeButtons.get(`${flowId}:${node.id}`)) : null))
        );
    }
    for (const draft of snapshot.drafts) {
        const flow = flowsById.get(draft.flowId);
        const liveWaiting = waitingByFlow.get(draft.flowId);
        const draftWaiting = waitingNodesOf(draft.graph);
        if (draftWaiting.length === 0) continue;
        const where = `draft ${draft.id} of ${flow ? describeFlow(flow) : `flow ${draft.flowId}`}`;

        for (const node of draftWaiting) {
            const live = liveWaiting?.get(node.id);
            const button = nodeButtons.get(`${draft.flowId}:${node.id}`);
            if (!live) {
                warn(`${where}: node ${node.id} exists only in the draft. Emptied; the builder says "Fill this in".`);
            } else if (!button) {
                warn(`${where}: node ${node.id} was never posted, so its draft copy is emptied too.`);
            } else if (!sameOldKeys(node.data, live.data)) {
                warn(
                    `${where}: node ${node.id} had its button changed in the draft (${describeOldKeys(node.data)}; live: ` +
                        `${describeOldKeys(live.data)}). The draft now names the live node's button "${button.buttonKey}" on ` +
                        `message "${button.messageKey}"; the draft's change to it is dropped.`
                );
            }
        }
        writes.draftGraphs.set(
            draft.id,
            rewriteGraph(draft.graph, (node) =>
                isWaiting(node) ? converted(node.data, liveWaiting?.has(node.id) ? nodeButtons.get(`${draft.flowId}:${node.id}`) : undefined) : null
            )
        );
    }

    // --- The journeys, checked against the frozen rules before anything is written.
    for (const journey of snapshot.journeys.values()) {
        if (!journeyChanged(journey)) continue;
        assertCoherent(guildId, journey);
    }

    logSummary({ snapshot, writes, summary, journeyOfFlow, nodeButtons, waitingByFlow, log });
    return writes;
}

/**
 * Put every flow with a posted message in a journey (Douglas's answer 1), recording the links
 * to write, and return flow id → journey key.
 */
function assignJourneys(
    snapshot: GuildSnapshot,
    postingFlows: readonly FlowRow[],
    postedByFlow: ReadonlyMap<string, ReadonlyMap<string, PostRow>>,
    writes: GuildWrites,
    warn: (line: string) => void
): Map<string, string> {
    // The journey each flow is in now, as `resolveFlowJourney` reads it: its link, else the
    // journey keyed by its own id — and none when its link names a journey that is gone.
    const currentJourney = new Map<string, string | null>();
    for (const flow of postingFlows) {
        const linked = snapshot.links.get(flow.flowId);
        if (linked !== undefined) {
            if (snapshot.journeys.has(linked)) {
                currentJourney.set(flow.flowId, linked);
            } else {
                warn(`${describeFlow(flow)} is linked to journey "${linked}", which is gone. It is linked again below.`);
                currentJourney.set(flow.flowId, null);
            }
            continue;
        }
        currentJourney.set(flow.flowId, snapshot.journeys.has(flow.flowId) ? flow.flowId : null);
    }

    const channelsOf = (flow: FlowRow): string[] =>
        [...(postedByFlow.get(flow.flowId) as ReadonlyMap<string, PostRow>).values()]
            .sort((left, right) => left.id - right.id)
            .map((post) => post.channelId);

    // The journeys that already hold a channel — a settled text-channel binding, of a journey
    // still there — in key order. A group posting there counts such a journey as one of its
    // own, though none of its flows is in it: linking the group to it reuses the binding
    // (channel rule 1), where a journey of its own would adopt a channel another already
    // holds, and Install would refuse it.
    const holdersOf = (channelId: string): string[] =>
        [
            ...new Set(
                snapshot.bindings
                    .filter(
                        (binding) =>
                            binding.ownerKind === 'journey' &&
                            binding.kind === 'textChannel' &&
                            binding.state !== 'intended' &&
                            binding.discordId === channelId &&
                            snapshot.journeys.has(binding.ownerKey)
                    )
                    .map((binding) => binding.ownerKey)
            ),
        ].sort();

    // Every journey a flow brings to its group: the one it is in, then each holding a channel it posted into.
    const journeysOf = (flow: FlowRow): string[] => {
        const current = currentJourney.get(flow.flowId);
        return [...new Set([...(current ? [current] : []), ...channelsOf(flow).flatMap(holdersOf)])];
    };

    // Groups, transitively: a shared channel, or a shared journey, joins two flows.
    const parent = new Map(postingFlows.map((flow) => [flow.flowId, flow.flowId]));
    const root = (flowId: string): string => {
        let current = flowId;
        while (parent.get(current) !== current) current = parent.get(current) as string;
        return current;
    };
    const join = (left: string, right: string): void => {
        const [leftRoot, rightRoot] = [root(left), root(right)];
        if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    const firstByChannel = new Map<string, string>();
    const firstByJourney = new Map<string, string>();
    for (const flow of postingFlows) {
        for (const channelId of (postedByFlow.get(flow.flowId) as ReadonlyMap<string, PostRow>).keys()) {
            const first = firstByChannel.get(channelId);
            if (first) join(first, flow.flowId);
            else firstByChannel.set(channelId, flow.flowId);
        }
        for (const journeyKey of journeysOf(flow)) {
            const first = firstByJourney.get(journeyKey);
            if (first) join(first, flow.flowId);
            else firstByJourney.set(journeyKey, flow.flowId);
        }
    }

    const groups = new Map<string, FlowRow[]>();
    for (const flow of postingFlows) {
        const members = groups.get(root(flow.flowId)) ?? [];
        members.push(flow);
        groups.set(root(flow.flowId), members);
    }

    const journeyOfFlow = new Map<string, string>();
    for (const members of groups.values()) {
        // Members are in `flows.id` order, so the first is the oldest.
        const journeyKeys = [...new Set(members.flatMap(journeysOf))];

        if (journeyKeys.length <= 1) {
            const journeyKey = journeyKeys[0] ?? ensureJourneyFor(snapshot, members[0] as FlowRow);
            for (const flow of members) journeyOfFlow.set(flow.flowId, journeyKey);
            continue;
        }

        const sharedChannels = [...new Set(members.flatMap(channelsOf))].filter(
            (channelId) =>
                holdersOf(channelId).length > 0 ||
                members.filter((flow) => postedByFlow.get(flow.flowId)?.has(channelId)).length > 1
        );
        warn(
            `${members.map(describeFlow).join(', ')} posted buttons into shared channels (${sharedChannels.join(', ')}) ` +
                `that different journeys already hold or sit in (${journeyKeys.map((key) => `"${key}"`).join(', ')}). ` +
                "Bindings can't move, so nothing was merged: a flow in a journey keeps it, one in none joins the journey " +
                'of a channel it shares, and Install will refuse the second journey to adopt a shared channel. Point one ' +
                'trigger at another message.'
        );
        for (const [flowId, journeyKey] of hazardJourneys(snapshot, members, currentJourney, channelsOf, holdersOf)) {
            journeyOfFlow.set(flowId, journeyKey);
        }
    }

    for (const flow of postingFlows) {
        const journeyKey = journeyOfFlow.get(flow.flowId) as string;
        if (snapshot.links.get(flow.flowId) !== journeyKey) writes.links.set(flow.flowId, journeyKey);
    }
    return journeyOfFlow;
}

/**
 * Each member of a group that can't merge, and its journey: the one it is in, else the
 * journey of a channel it posted into — the journey holding that channel, else the oldest
 * member posting there that has one — so a flow in no journey never gets a new one beside
 * journeys already sharing its channel, which would only be one more journey Install refuses
 * there. Channels are asked in the order the flow posted into them, and a member that took a
 * journey this way can pass it on to the next. A member none of that reaches starts a journey
 * of its own, which the rest of its channels then share.
 */
function hazardJourneys(
    snapshot: GuildSnapshot,
    members: readonly FlowRow[],
    currentJourney: ReadonlyMap<string, string | null>,
    channelsOf: (flow: FlowRow) => string[],
    holdersOf: (channelId: string) => string[]
): Map<string, string> {
    const assigned = new Map<string, string>();
    for (const flow of members) {
        const current = currentJourney.get(flow.flowId);
        if (current) assigned.set(flow.flowId, current);
    }

    const sharedJourney = (flow: FlowRow): string | undefined => {
        for (const channelId of channelsOf(flow)) {
            const holder = holdersOf(channelId)[0];
            if (holder) return holder;
            const poster = members.find(
                (other) => other !== flow && assigned.has(other.flowId) && channelsOf(other).includes(channelId)
            );
            if (poster) return assigned.get(poster.flowId);
        }
        return undefined;
    };

    while (assigned.size < members.length) {
        let moved = false;
        for (const flow of members) {
            if (assigned.has(flow.flowId)) continue;
            const journeyKey = sharedJourney(flow);
            if (!journeyKey) continue;
            assigned.set(flow.flowId, journeyKey);
            moved = true;
        }
        if (!moved) {
            const first = members.find((flow) => !assigned.has(flow.flowId)) as FlowRow;
            assigned.set(first.flowId, ensureJourneyFor(snapshot, first));
        }
    }
    return assigned;
}

/** The journey keyed by `flow`'s id: the one there, or a new one named after it. */
function ensureJourneyFor(snapshot: GuildSnapshot, flow: FlowRow): string {
    if (!snapshot.journeys.has(flow.flowId)) {
        if (!KEY_PATTERN.test(flow.flowId) || flow.flowId.length > KEY_MAX_LENGTH) {
            throw new Error(
                `${LOG_PREFIX}: flow ${flow.flowId} in guild ${snapshot.guildId} needs a journey keyed by its id, and that id ` +
                    'is not a resource key. Fix the row by hand, then migrate again.'
            );
        }
        snapshot.journeys.set(flow.flowId, {
            journeyKey: flow.flowId,
            name: clip(flow.name.trim(), NAME_MAX_LENGTH).trim() || FALLBACK.journeyName,
            createdForFlowId: flow.flowId,
            updatedAtMs: null,
            storedResources: null,
            resources: [],
        });
    }
    return flow.flowId;
}

/**
 * The key of the text channel `channelId` is declared under in `journey`, declaring it when
 * nothing does, and how it was found — or, when no key can hold it, why.
 */
function declareChannel(
    snapshot: GuildSnapshot,
    journey: JourneyState,
    channelId: string,
    postedNodes: readonly GraphNode[],
    flow: FlowRow,
    warn: (line: string) => void
): { readonly key: string; readonly how: string } | { readonly refused: string } {
    const declared = (key: string): JsonObject | undefined => journey.resources.find((resource) => resource.key === key);
    const settledOwnBindings = snapshot.bindings.filter(
        (binding) =>
            binding.ownerKind === 'journey' &&
            binding.ownerKey === journey.journeyKey &&
            binding.kind === 'textChannel' &&
            binding.state !== 'intended'
    );
    const ownBindings = settledOwnBindings.filter((binding) => binding.discordId === channelId);
    const isTextChannel = (resource: JsonObject | undefined): boolean => resource?.kind === 'textChannel';
    const boundTo = (key: string): boolean => ownBindings.some((binding) => binding.resourceKey === key);
    // A key installed as another channel: its declaration may still adopt this one, but the
    // binding is where the key lives, and a message parented on it would be in the wrong
    // channel — Install blocks that ("Discord can't move a message").
    const boundElsewhere = (key: string): BindingRow | undefined =>
        settledOwnBindings.find((binding) => binding.resourceKey === key && !!binding.discordId && binding.discordId !== channelId);

    const found = ((): { key: string; how: string } | undefined => {
        // 1. Bound here under a key still declared.
        const bound = ownBindings.find((binding) => isTextChannel(declared(binding.resourceKey)));
        if (bound) return { key: bound.resourceKey, how: 'bound to this journey' };

        // 2. A node's sidecar, naming a declared channel that adopts or is bound to it.
        for (const node of postedNodes) {
            const sidecar = node.data.channelIdKey;
            if (typeof sidecar !== 'string') continue;
            const resource = declared(sidecar);
            if (
                isTextChannel(resource) &&
                !boundElsewhere(sidecar) &&
                (resource?.adoptDiscordId === channelId || boundTo(sidecar))
            ) {
                return { key: sidecar, how: 'named by the node’s channel key' };
            }
        }

        // 3. Declared already, adopting it.
        const adopting = journey.resources.find(
            (resource) => isTextChannel(resource) && resource.adoptDiscordId === channelId && !boundElsewhere(String(resource.key))
        );
        if (adopting) return { key: String(adopting.key), how: 'already declared, adopting it' };

        // 4. Bound here under a key no longer declared: declared again under that key, so
        // install reuses the binding (review item 23).
        const orphaned = ownBindings.find((binding) => !declared(binding.resourceKey));
        if (orphaned) {
            journey.resources.push({
                key: orphaned.resourceKey,
                kind: 'textChannel',
                defaultName: channelName(orphaned.name, flow),
            });
            return { key: orphaned.resourceKey, how: 'declared again under the key it is bound to' };
        }
        return undefined;
    })();
    if (found) {
        warnIfHeldElsewhere(snapshot, journey, channelId, warn);
        return found;
    }

    // Declared adopting it under a key installed elsewhere (skipped above), or as something
    // other than a text channel: a second declaration may not adopt the same channel, so
    // nothing here can hold the message.
    const misbound = journey.resources.find((resource) => resource.adoptDiscordId === channelId);
    if (misbound) {
        const binding = boundElsewhere(String(misbound.key));
        const how = binding ? `, but installed that key as channel ${binding.discordId}` : ` as a ${String(misbound.kind)}`;
        return {
            refused:
                `journey "${journey.journeyKey}" declares "${String(misbound.key)}" adopting channel ${channelId}${how}, ` +
                `and a second declaration can't adopt ${channelId} too`,
        };
    }

    // 5. New: adopted by id, named as the guild already names it, else after the flow.
    const knownName = snapshot.bindings.find(
        (binding) => binding.kind === 'textChannel' && binding.discordId === channelId && binding.state !== 'intended'
    )?.name;
    const defaultName = channelName(knownName ?? placeholderChannelName(flow), flow);
    const key = uniqueKey(slugOf(defaultName), FALLBACK.channelKey, takenKeys(snapshot, journey));
    journey.resources.push({ key, kind: 'textChannel', defaultName, adoptDiscordId: channelId });
    warnIfHeldElsewhere(snapshot, journey, channelId, warn);
    return {
        key,
        how: `declared, adopting it by id as "${defaultName}" — install checks it is still there`,
    };
}

/** Log `channelId` when an owner other than `journey` holds or adopts it: install will refuse one of them. */
function warnIfHeldElsewhere(snapshot: GuildSnapshot, journey: JourneyState, channelId: string, warn: (line: string) => void): void {
    const holders = new Set<string>();
    for (const binding of snapshot.bindings) {
        if (binding.discordId !== channelId || binding.state === 'intended') continue;
        if (binding.ownerKind === 'journey' && binding.ownerKey === journey.journeyKey) continue;
        holders.add(binding.ownerKind === 'journey' ? `journey "${binding.ownerKey}" (installed)` : 'the ticket system');
    }
    for (const other of snapshot.journeys.values()) {
        if (other.journeyKey === journey.journeyKey) continue;
        if (other.resources.some((resource) => resource.adoptDiscordId === channelId)) {
            holders.add(`journey "${other.journeyKey}" (declared)`);
        }
    }
    if (holders.size === 0) return;
    warn(
        `journey "${journey.journeyKey}" adopts channel ${channelId}, which ${[...holders].join(' and ')} already ` +
            'hold(s). One owner per channel: Install will refuse whichever adopts it second until the other lets go.'
    );
}

interface DeclaredMessage {
    readonly key: string;
    readonly name: string;
    readonly newBinding: boolean;
    readonly buttons: readonly { readonly nodeId: string; readonly buttonKey: string }[];
}

/**
 * The message resource for one posted message, declared — or recognised, on a run after a
 * `down`: by its binding, else as the message in that channel named after the flow.
 */
function declareMessage(input: {
    readonly snapshot: GuildSnapshot;
    readonly journey: JourneyState;
    readonly flow: FlowRow;
    readonly post: PostRow;
    readonly channelKey: string;
    readonly postedNodes: readonly GraphNode[];
    readonly claimedMessages: Set<string>;
    readonly warn: (line: string) => void;
}): DeclaredMessage {
    const { snapshot, journey, flow, post, channelKey, postedNodes, claimedMessages, warn } = input;

    const strippedName = withoutTokenBraces(flow.name);
    if (strippedName !== flow.name) {
        warn(`${describeFlow(flow)}: its name holds {{ or }}, which a posted message refuses. Its message is named "${strippedName}".`);
    }
    const name = clip(strippedName.trim(), NAME_MAX_LENGTH).trim() || FALLBACK.messageName;
    if (strippedName.trim() && name !== strippedName.trim()) {
        warn(`${describeFlow(flow)}: its name is over ${NAME_MAX_LENGTH} characters, so its message is named "${name}".`);
    }
    const shown = strippedName.trim() ? strippedName : name;
    const content = `**${clip(shown, CONTENT_MAX_LENGTH - 4)}**`;

    // A message already bound to this post is reused under its key; one bound elsewhere
    // cannot be, since only this migration binds an old Deploy message.
    const bound = snapshot.bindings.find((binding) => binding.kind === 'message' && binding.discordId === post.messageId);
    if (bound && (bound.ownerKind !== 'journey' || bound.ownerKey !== journey.journeyKey)) {
        throw new Error(
            `${LOG_PREFIX}: message ${post.messageId} in guild ${snapshot.guildId} is already bound to ${bound.ownerKind} ` +
                `"${bound.ownerKey}", not journey "${journey.journeyKey}". Fix the rows by hand, then migrate again.`
        );
    }
    // Else one this migration declared and a `down` unbound: in that channel, under that
    // name, holding exactly what Deploy posted, and bound to nothing — never a message an
    // operator declared, which has words of its own or a binding.
    const recognised =
        bound?.resourceKey ??
        journey.resources.find(
            (resource) =>
                resource.kind === 'message' &&
                resource.parentKey === channelKey &&
                resource.defaultName === name &&
                isPlainObject(resource.message) &&
                resource.message.content === content &&
                Array.isArray(resource.message.embeds) &&
                resource.message.embeds.length === 0 &&
                !takenByBinding(snapshot, journey, String(resource.key)) &&
                !claimedMessages.has(`${journey.journeyKey}\u0000${String(resource.key)}`)
        )?.key;
    const key =
        typeof recognised === 'string' ? recognised : uniqueKey(slugOf(name), FALLBACK.messageKey, takenKeys(snapshot, journey));
    claimedMessages.add(`${journey.journeyKey}\u0000${key}`);

    const takenButtonKeys = new Set<string>();
    const buttons = postedNodes.map((node) => {
        const label = buttonLabel(node, flow, warn);
        const buttonKey = uniqueKey(slugOf(label), FALLBACK.buttonKey, takenButtonKeys);
        takenButtonKeys.add(buttonKey);
        return { nodeId: node.id, buttonKey, label, style: buttonStyle(node, flow, warn) };
    });

    const resource: JsonObject = {
        key,
        kind: 'message',
        defaultName: name,
        parentKey: channelKey,
        message: { content, embeds: [] },
        buttons: buttons.map((button) => ({ key: button.buttonKey, label: button.label, style: button.style })),
    };
    const at = journey.resources.findIndex((candidate) => candidate.key === key);
    if (at === -1) journey.resources.push(resource);
    else journey.resources[at] = resource;

    return { key, name, newBinding: !bound, buttons };
}

/** A posted node's label, as its button will say it: no token braces, 1–80 characters. */
function buttonLabel(node: GraphNode, flow: FlowRow, warn: (line: string) => void): string {
    const raw = typeof node.data.label === 'string' ? node.data.label : '';
    const stripped = withoutTokenBraces(raw);
    const label = stripped.trim() ? clip(stripped, LABEL_MAX_LENGTH) : FALLBACK.label;
    if (label === raw) return label;

    const reasons = [
        ...(stripped !== raw ? ['it holds {{ or }}, which a posted message refuses'] : []),
        ...(!stripped.trim() ? ['nothing is left of it'] : []),
        ...(stripped.trim() && label !== stripped ? [`it is over ${LABEL_MAX_LENGTH} characters`] : []),
    ];
    warn(`node ${node.id} of ${describeFlow(flow)}: its label ${JSON.stringify(raw)} won't do — ${reasons.join(', and ')} — so its button says "${label}".`);
    return label;
}

/** A posted node's style: its own when a button takes it, the old default when it has none. */
function buttonStyle(node: GraphNode, flow: FlowRow, warn: (line: string) => void): string {
    const style = node.data.style;
    if (style === undefined) return DEFAULT_STYLE;
    if (typeof style === 'string' && BUTTON_STYLES.includes(style)) return style;
    warn(`node ${node.id} of ${describeFlow(flow)} has the style ${JSON.stringify(style)}, which no button takes. It becomes ${DEFAULT_STYLE}.`);
    return DEFAULT_STYLE;
}

/** A text channel's name as Discord holds it — lowercase, whitespace hyphenated — in at most 100 characters. */
function channelName(name: string, flow: FlowRow): string {
    const normalise = (raw: string): string => clip(raw.toLowerCase().replace(/\s/g, '-'), NAME_MAX_LENGTH);
    return normalise(name) || normalise(placeholderChannelName(flow));
}

/**
 * "<flow name> channel": what an adopted channel nobody has named is declared as. A
 * placeholder only — an adopted channel keeps its own name, and repair never renames it.
 */
function placeholderChannelName(flow: FlowRow): string {
    return `${withoutTokenBraces(flow.name).trim()} channel`.trim();
}

/** Every key a new resource of `journey` must step over: those it declares, and those it holds a binding under. */
function takenKeys(snapshot: GuildSnapshot, journey: JourneyState): ReadonlySet<string> {
    const taken = new Set(journey.resources.map((resource) => String(resource.key)));
    for (const binding of snapshot.bindings) {
        if (binding.ownerKind === 'journey' && binding.ownerKey === journey.journeyKey) taken.add(binding.resourceKey);
    }
    return taken;
}

/** Whether `journey` holds a binding under `key`. */
function takenByBinding(snapshot: GuildSnapshot, journey: JourneyState, key: string): boolean {
    return snapshot.bindings.some(
        (binding) => binding.ownerKind === 'journey' && binding.ownerKey === journey.journeyKey && binding.resourceKey === key
    );
}

/** The converted node's data: its old keys gone, and `button` when it was posted. */
function converted(data: JsonObject, button: ButtonRef | undefined): JsonObject {
    const kept = Object.fromEntries(Object.entries(data).filter(([key]) => !OLD_KEYS.includes(key)));
    return button ? { button: { messageKey: button.messageKey, buttonKey: button.buttonKey }, ...kept } : kept;
}

/** Button Click nodes still in the old shape: no `button`, and at least one old key. */
function waitingNodesOf(graph: Graph): GraphNode[] {
    return graph.nodes.filter(isWaiting);
}

function isWaiting(node: unknown): node is GraphNode {
    return (
        isButtonClickNode(node) && !('button' in node.data) && OLD_KEYS.some((key) => key in node.data)
    );
}

function isButtonClickNode(node: unknown): node is GraphNode {
    return isPlainObject(node) && node.type === TRIGGER_BUTTON_CLICK && typeof node.id === 'string' && isPlainObject(node.data);
}

/** `graph` with each node `transform` answers for replaced; `null` leaves a node as it is. */
function rewriteGraph(graph: Graph, transform: (node: GraphNode) => JsonObject | null): Graph {
    return {
        ...graph,
        nodes: graph.nodes.map((node) => {
            if (!isButtonClickNode(node)) return node;
            const data = transform(node);
            return data ? { ...node, data } : node;
        }),
    };
}

function sameOldKeys(left: JsonObject, right: JsonObject): boolean {
    return OLD_KEYS.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function describeOldKeys(data: JsonObject): string {
    return OLD_KEYS.filter((key) => key in data)
        .map((key) => `${key} ${JSON.stringify(data[key])}`)
        .join(', ');
}

function describeFlow(flow: FlowRow): string {
    return `flow "${flow.name}" (${flow.flowId})`;
}

/** Whether `journey`'s resources differ from what is stored — by content, since `jsonb` reorders keys. */
function journeyChanged(journey: JourneyState): boolean {
    return journey.storedResources !== canonicalJson(journey.resources);
}

/** JSON with every object's keys sorted, so two values equal in content serialise the same. */
function canonicalJson(value: unknown): string {
    const sorted = (current: unknown): unknown => {
        if (Array.isArray(current)) return current.map(sorted);
        if (!isPlainObject(current)) return current;
        return Object.fromEntries(
            Object.keys(current)
                .sort()
                .map((key) => [key, sorted(current[key])])
        );
    };
    return JSON.stringify(sorted(value));
}

/**
 * Refuse to store a journey that every read would refuse, or the dashboard would not save:
 * the frozen copy of the rules this migration can break. A throw writes nothing, on either
 * dialect, and names the journey.
 */
function assertCoherent(guildId: string, journey: JourneyState): void {
    const fail = (reason: string): never => {
        throw new Error(
            `${LOG_PREFIX}: journey "${journey.journeyKey}" in guild ${guildId} would be stored broken — ${reason}. ` +
                'If the journey was already like that, fix it by hand, then migrate again.'
        );
    };
    if (journey.resources.length > MAX_RESOURCES) fail(`it would declare ${journey.resources.length} resources, over ${MAX_RESOURCES}`);

    const byKey = new Map<string, JsonObject>();
    const adopted = new Set<string>();
    for (const resource of journey.resources) {
        const key = String(resource.key);
        if (byKey.has(key)) fail(`the key "${key}" is declared twice`);
        byKey.set(key, resource);
        if (typeof resource.adoptDiscordId === 'string') {
            if (adopted.has(resource.adoptDiscordId)) fail(`two resources adopt ${resource.adoptDiscordId}`);
            adopted.add(resource.adoptDiscordId);
        }
    }
    for (const resource of journey.resources) {
        if (resource.kind !== 'message') continue;
        const key = String(resource.key);
        if (!KEY_PATTERN.test(key) || key.length > KEY_MAX_LENGTH) fail(`the message key "${key}" is not a resource key`);
        if (byKey.get(String(resource.parentKey))?.kind !== 'textChannel') fail(`message "${key}" is not under a declared text channel`);
        const buttons = Array.isArray(resource.buttons) ? resource.buttons : [];
        if (buttons.length > MAX_BUTTONS) fail(`message "${key}" has ${buttons.length} buttons`);
    }
}

/** One summary per guild that had anything to convert: every journey written, link, channel and message. */
function logSummary(input: {
    readonly snapshot: GuildSnapshot;
    readonly writes: GuildWrites;
    readonly summary: ReadonlyMap<string, readonly string[]>;
    readonly journeyOfFlow: ReadonlyMap<string, string>;
    readonly nodeButtons: ReadonlyMap<string, ButtonRef>;
    readonly waitingByFlow: ReadonlyMap<string, ReadonlyMap<string, GraphNode>>;
    readonly log: LogLine[];
}): void {
    const { snapshot, writes, summary, journeyOfFlow, nodeButtons, waitingByFlow, log } = input;
    if (waitingByFlow.size === 0 && writes.bindings.length === 0) return;

    const waitingCount = [...waitingByFlow.values()].reduce((total, waiting) => total + waiting.size, 0);
    const lines = [
        `${LOG_PREFIX}, guild ${snapshot.guildId}: ${nodeButtons.size} trigger(s) converted and ` +
            `${waitingCount - nodeButtons.size} emptied, in ${waitingByFlow.size} flow(s); ${writes.bindings.length} ` +
            `message(s) adopted; ${writes.draftGraphs.size} draft(s) rewritten.`,
    ];
    for (const [journeyKey, journeyLines] of summary) {
        const journey = snapshot.journeys.get(journeyKey) as JourneyState;
        const origin =
            journey.updatedAtMs === null
                ? `created for flow ${String(journey.createdForFlowId)}`
                : journeyChanged(journey)
                  ? 'existing, updated'
                  : 'existing, unchanged';
        const members = snapshot.flows
            .filter((flow) => journeyOfFlow.get(flow.flowId) === journeyKey)
            .map((flow) => `${describeFlow(flow)}${writes.links.has(flow.flowId) ? ' (linked now)' : ''}`);
        lines.push(`  journey "${journeyKey}" ("${journey.name}", ${origin}): ${members.join(', ')}`);
        lines.push(...journeyLines);
    }
    log.push({ level: 'log', text: lines.join('\n') });
}

/** Write what {@link convertGuild} decided, on `db` only. */
async function writeGuild(db: Kysely<any>, snapshot: GuildSnapshot, writes: GuildWrites): Promise<void> {
    const { guildId } = snapshot;
    const now = Date.now();

    for (const journey of snapshot.journeys.values()) {
        if (!journeyChanged(journey)) continue;
        if (journey.updatedAtMs === null) {
            const stamp = new Date(now).toISOString();
            await db
                .insertInto('journeys')
                .values({
                    journey_key: journey.journeyKey,
                    guild_id: guildId,
                    name: journey.name,
                    description: null,
                    resources: JSON.stringify(journey.resources),
                    created_for_flow_id: journey.createdForFlowId,
                    created_at: stamp,
                    updated_at: stamp,
                })
                .execute();
            continue;
        }
        // The resource version only moves forward, by a millisecond at least.
        const version = new Date(Math.max(now, journey.updatedAtMs + 1)).toISOString();
        await db
            .updateTable('journeys')
            .set({ resources: JSON.stringify(journey.resources), updated_at: version })
            .where('guild_id', '=', guildId)
            .where('journey_key', '=', journey.journeyKey)
            .execute();
    }

    const stamp = new Date(now).toISOString();
    for (const [flowId, journeyKey] of writes.links) {
        if (snapshot.links.has(flowId)) {
            await db
                .updateTable('flow_journey_links')
                .set({ journey_key: journeyKey, updated_at: stamp })
                .where('guild_id', '=', guildId)
                .where('flow_id', '=', flowId)
                .execute();
        } else {
            await db
                .insertInto('flow_journey_links')
                .values({ guild_id: guildId, flow_id: flowId, journey_key: journeyKey, created_at: stamp, updated_at: stamp })
                .execute();
        }
    }

    for (const binding of writes.bindings) {
        await db
            .insertInto('resource_bindings')
            .values({
                guild_id: guildId,
                owner_kind: 'journey',
                owner_key: binding.journeyKey,
                resource_key: binding.resourceKey,
                kind: 'message',
                state: 'created',
                discord_id: binding.messageId,
                name: binding.name,
                message_channel_id: binding.channelId,
                message_digest: null,
                created_at: stamp,
                updated_at: stamp,
            })
            .execute();
    }

    for (const [flowId, graph] of writes.flowGraphs) {
        await db.updateTable('flows').set({ graph: JSON.stringify(graph) }).where('flow_id', '=', flowId).execute();
    }
    for (const [draftId, graph] of writes.draftGraphs) {
        await db.updateTable('flow_drafts').set({ graph: JSON.stringify(graph) }).where('id', '=', draftId).execute();
    }
}

// ---------------------------------------------------------------------------------------
// Down
// ---------------------------------------------------------------------------------------

async function migrateDown(db: Kysely<any>): Promise<void> {
    const log: LogLine[] = [];
    for (const snapshot of await readGuilds(db)) {
        const warn = (line: string): void => {
            log.push({ level: 'warn', text: `${LOG_PREFIX} (down), guild ${snapshot.guildId}: ${line}` });
        };
        let reverted = 0;

        const journeyOf = (flowId: string): JourneyState | undefined => {
            const linked = snapshot.links.get(flowId);
            return snapshot.journeys.get(linked ?? flowId);
        };
        const restore = (graph: Graph, flowId: string, where: string): Graph | null => {
            let changed = false;
            const rewritten = rewriteGraph(graph, (node) => {
                if (!isPlainObject(node.data.button)) return null;
                const restored = restoredNode(snapshot, journeyOf(flowId), node, `${where}, node ${node.id}`, warn);
                if (!restored) return null;
                changed = true;
                reverted += 1;
                return restored;
            });
            return changed ? rewritten : null;
        };

        for (const flow of snapshot.flows) {
            const graph = restore(flow.graph, flow.flowId, describeFlow(flow));
            if (graph) await db.updateTable('flows').set({ graph: JSON.stringify(graph) }).where('flow_id', '=', flow.flowId).execute();
        }
        for (const draft of snapshot.drafts) {
            const graph = restore(draft.graph, draft.flowId, `draft ${draft.id} of flow ${draft.flowId}`);
            if (graph) await db.updateTable('flow_drafts').set({ graph: JSON.stringify(graph) }).where('id', '=', draft.id).execute();
        }

        // Only the bindings `up` wrote: messages, of journeys, naming an old Deploy message.
        const messageIds = [...new Set(snapshot.posts.map((post) => post.messageId))];
        const forgotten = snapshot.bindings.filter(
            (binding) => binding.ownerKind === 'journey' && binding.kind === 'message' && messageIds.includes(binding.discordId ?? '')
        );
        if (forgotten.length > 0) {
            await db
                .deleteFrom('resource_bindings')
                .where('guild_id', '=', snapshot.guildId)
                .where('owner_kind', '=', 'journey')
                .where('kind', '=', 'message')
                .where('discord_id', 'in', messageIds)
                .execute();
        }

        if (reverted > 0 || forgotten.length > 0) {
            log.push({
                level: 'log',
                text:
                    `${LOG_PREFIX} (down), guild ${snapshot.guildId}: ${reverted} trigger(s) written back to their own button; ` +
                    `${forgotten.length} message binding(s) forgotten (${forgotten.map((binding) => binding.discordId).join(', ')}). ` +
                    'Declarations, journeys and links are left. Do not Install or Repair a converted journey on this code: ' +
                    'it would post its message a second time.',
            });
        }
    }
    printLog(log);
}

/**
 * A converted node back in the old shape, from the message and button its journey declares —
 * or `null`, leaving it as it is, when its journey declares no such button: there is no label
 * to give it, and stripping `button` would only lose the one thing that says what it was.
 */
function restoredNode(
    snapshot: GuildSnapshot,
    journey: JourneyState | undefined,
    node: GraphNode,
    where: string,
    warn: (line: string) => void
): JsonObject | null {
    const { button, ...kept } = node.data;
    const ref = isPlainObject(button) ? button : {};
    const message = journey?.resources.find((resource) => resource.kind === 'message' && resource.key === ref.messageKey);
    const declared = message && Array.isArray(message.buttons) ? message.buttons.filter(isPlainObject) : [];
    const picked = declared.find((candidate) => candidate.key === ref.buttonKey);
    if (!picked) {
        warn(
            `${where}: its journey declares no button "${String(ref.buttonKey)}" on a message "${String(ref.messageKey)}", ` +
                'so it is left naming it. Step 2 reads it as unfinished.'
        );
        return null;
    }
    const parent = journey?.resources.find((resource) => resource.kind === 'textChannel' && resource.key === message?.parentKey);

    const restored: JsonObject = { ...kept };
    const parentKey = typeof message?.parentKey === 'string' ? message.parentKey : undefined;
    const channelId =
        typeof parent?.adoptDiscordId === 'string'
            ? parent.adoptDiscordId
            : snapshot.bindings.find(
                  (binding) =>
                      binding.ownerKind === 'journey' &&
                      binding.ownerKey === journey?.journeyKey &&
                      binding.resourceKey === parentKey &&
                      binding.kind === 'textChannel' &&
                      binding.state !== 'intended' &&
                      binding.discordId
              )?.discordId;
    restored.channelId = channelId ?? '';
    if (!channelId && parentKey) restored.channelIdKey = parentKey;
    restored.label = picked.label;
    restored.style = typeof picked.style === 'string' ? picked.style : DEFAULT_STYLE;

    if (!channelId) {
        warn(
            parentKey
                ? `${where}: its channel "${parentKey}" has no id yet, so it comes back naming that key.`
                : `${where}: its message has no channel, so it comes back with none.`
        );
    }
    return restored;
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

/** Every guild with a flow or a posted-buttons row, read whole, in a stable order. */
async function readGuilds(db: Kysely<any>): Promise<GuildSnapshot[]> {
    const flowRows: JsonObject[] = await db.selectFrom('flows').select(['id', 'flow_id', 'guild_id', 'name', 'graph']).execute();
    const draftRows: JsonObject[] = await db.selectFrom('flow_drafts').select(['id', 'flow_id', 'guild_id', 'graph']).execute();
    const journeyRows: JsonObject[] = await db
        .selectFrom('journeys')
        .select(['guild_id', 'journey_key', 'name', 'resources', 'created_for_flow_id', 'updated_at'])
        .execute();
    const linkRows: JsonObject[] = await db.selectFrom('flow_journey_links').select(['guild_id', 'flow_id', 'journey_key']).execute();
    const bindingRows: JsonObject[] = await db
        .selectFrom('resource_bindings')
        .select(['guild_id', 'owner_kind', 'owner_key', 'resource_key', 'kind', 'state', 'discord_id', 'name'])
        .execute();
    const postRows: JsonObject[] = await db
        .selectFrom('flow_button_messages')
        .select(['id', 'guild_id', 'flow_id', 'channel_id', 'message_id', 'node_ids'])
        .execute();

    const guildIds = [...new Set([...flowRows, ...postRows].map((row) => text(row, 'guild_id')))].sort();
    const byGuild = <T>(rows: readonly JsonObject[], guildId: string, read: (row: JsonObject) => T): T[] =>
        rows.filter((row) => text(row, 'guild_id') === guildId).map(read);

    return guildIds.map((guildId) => {
        const journeys = new Map<string, JourneyState>();
        for (const row of journeyRows.filter((candidate) => text(candidate, 'guild_id') === guildId)) {
            const journeyKey = text(row, 'journey_key');
            const resources = parsedJson(column(row, 'resources'), `journey "${journeyKey}" in guild ${guildId}`);
            if (!Array.isArray(resources) || !resources.every(isPlainObject)) {
                throw new Error(
                    `${LOG_PREFIX}: journey "${journeyKey}" in guild ${guildId} holds resources that are not a list of ` +
                        'objects. Fix the row by hand, then migrate again.'
                );
            }
            const createdFor = column(row, 'created_for_flow_id');
            journeys.set(journeyKey, {
                journeyKey,
                name: text(row, 'name'),
                createdForFlowId: typeof createdFor === 'string' ? createdFor : null,
                updatedAtMs: millisecondsOf(column(row, 'updated_at'), `journey "${journeyKey}" in guild ${guildId}`),
                storedResources: canonicalJson(resources),
                resources: resources.map((resource) => ({ ...resource })),
            });
        }

        return {
            guildId,
            flows: byGuild(flowRows, guildId, (row) => ({
                id: Number(column(row, 'id')),
                flowId: text(row, 'flow_id'),
                name: text(row, 'name'),
                graph: graphOf(column(row, 'graph'), `flow ${text(row, 'flow_id')}`),
            })).sort((left, right) => left.id - right.id),
            drafts: byGuild(draftRows, guildId, (row) => ({
                id: Number(column(row, 'id')),
                flowId: text(row, 'flow_id'),
                graph: graphOf(column(row, 'graph'), `draft ${String(column(row, 'id'))}`),
            })).sort((left, right) => left.id - right.id),
            journeys,
            links: new Map(byGuild(linkRows, guildId, (row) => [text(row, 'flow_id'), text(row, 'journey_key')] as const)),
            bindings: byGuild(bindingRows, guildId, (row) => {
                const discordId = column(row, 'discord_id');
                return {
                    ownerKind: text(row, 'owner_kind'),
                    ownerKey: text(row, 'owner_key'),
                    resourceKey: text(row, 'resource_key'),
                    kind: text(row, 'kind'),
                    state: text(row, 'state'),
                    discordId: typeof discordId === 'string' ? discordId : null,
                    name: text(row, 'name'),
                };
            }),
            posts: byGuild(postRows, guildId, (row) => {
                const id = Number(column(row, 'id'));
                const nodeIds = parsedJson(column(row, 'node_ids'), `flow_button_messages row ${id}`);
                if (!Array.isArray(nodeIds) || !nodeIds.every((nodeId) => typeof nodeId === 'string')) {
                    throw new Error(
                        `${LOG_PREFIX}: flow_button_messages row ${id} in guild ${guildId} holds node_ids that are not a list ` +
                            'of node ids. Fix the row by hand, then migrate again.'
                    );
                }
                return {
                    id,
                    flowId: text(row, 'flow_id'),
                    channelId: text(row, 'channel_id'),
                    messageId: text(row, 'message_id'),
                    nodeIds,
                };
            }).sort((left, right) => left.id - right.id),
        };
    });
}

/** A result column, whether or not `CamelCasePlugin` renamed it. */
function column(row: JsonObject, snake: string): unknown {
    if (snake in row) return row[snake];
    return row[snake.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())];
}

function text(row: JsonObject, snake: string): string {
    return String(column(row, snake));
}

/** A JSON column: parsed by the production stack on SQLite and by `pg` for `jsonb`, a string through a bare client. */
function parsedJson(raw: unknown, described: string): unknown {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch (cause) {
        throw new Error(`${LOG_PREFIX}: ${described} holds JSON that does not parse. Fix the row by hand, then migrate again.`, {
            cause,
        });
    }
}

function graphOf(raw: unknown, described: string): Graph {
    const parsed = parsedJson(raw, described);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.nodes)) {
        throw new Error(
            `${LOG_PREFIX}: ${described} holds a graph that is not an object with a node list. Fix the row by hand, then migrate again.`
        );
    }
    return parsed as Graph;
}

/** A date column as milliseconds: a `Date` from `pg` or the date plugin, an ISO string from a bare client. */
function millisecondsOf(raw: unknown, described: string): number {
    const milliseconds = raw instanceof Date ? raw.getTime() : new Date(String(raw)).getTime();
    if (Number.isNaN(milliseconds)) {
        throw new Error(`${LOG_PREFIX}: ${described} has an updated_at that is not a date. Fix the row by hand, then migrate again.`);
    }
    return milliseconds;
}

// ---------------------------------------------------------------------------------------
// Frozen text rules
// ---------------------------------------------------------------------------------------

/** `copy` with every `{{` and `}}` gone, repeatedly, so none can form a token again. */
function withoutTokenBraces(copy: string): string {
    let stripped = copy;
    while (/\{\{|\}\}/.test(stripped)) stripped = stripped.replace(/\{\{|\}\}/g, '');
    return stripped;
}

/** The browser's slug (`slugifyResourceName`), as it stood: a key follows its name until it is installed or listened to. */
function slugOf(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, KEY_MAX_LENGTH)
        .replace(/-+$/, '');
}

/** `desired`, or `fallback` when it is empty, suffixed `-2`, `-3`… until no key in `taken` has it, in at most 64 characters. */
function uniqueKey(desired: string, fallback: string, taken: ReadonlySet<string>): string {
    const base = desired || fallback;
    if (!taken.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const tail = `-${suffix}`;
        const candidate = `${base.slice(0, KEY_MAX_LENGTH - tail.length).replace(/-+$/, '')}${tail}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** At most `max` characters, by code unit — the limit zod's `.max` counts. */
function clip(copy: string, max: number): string {
    return copy.length > max ? copy.slice(0, max) : copy;
}

function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
