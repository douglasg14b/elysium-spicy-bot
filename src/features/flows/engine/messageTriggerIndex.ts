import { visibleNodeData } from '../blocks/manifest';
import { getBlockDefinition, isTriggerStartedBy } from '../blocks/registry';
import { messageSentConfigSchema } from '../blocks/triggerMessageSent';
import { FLOW_MESSAGE_TRIGGER_READ_FAILURE_WINDOW_MS } from '../constants';
import type { FlowGraph } from '../data/flowGraph';
import { flowsRepo, type FlowsRepo } from '../data/flowsRepo';
import type { FlowEntity } from '../data/flowsSchema';

/** One enabled trigger a message can start, holding what it needs to run with no read. */
export interface MessageTriggerEntry {
    readonly flowId: string;
    /** The graph as loaded — kept so firing it reads nothing. A write drops the whole index. */
    readonly graph: FlowGraph;
    readonly nodeId: string;
    /** Lower-cased, trimmed text the message must contain, when the trigger filters on any. */
    readonly text?: string;
    /** Flow order then node order across the guild, so matches run in a stable order. */
    readonly position: number;
}

/** Where a message was posted, as the index matches it. */
export interface MessageWhere {
    readonly channelId: string;
    /** The channel a thread sits under, when posted in a thread. */
    readonly parentChannelId: string | null;
    /** The category the message's channel sits in — the thread's channel's, for a thread reply. */
    readonly categoryId: string | null;
}

/**
 * One guild's enabled triggers, by where each listens, so a message meets only the
 * triggers that could match it: those listening guild-wide, in its channel (or the
 * channel its thread sits under), or in its channel's category.
 */
export class GuildMessageTriggers {
    constructor(
        private readonly inGuild: readonly MessageTriggerEntry[],
        private readonly byChannel: ReadonlyMap<string, readonly MessageTriggerEntry[]>,
        private readonly byCategory: ReadonlyMap<string, readonly MessageTriggerEntry[]>
    ) {}

    /** Whether no trigger in the guild listens anywhere — the common case. */
    get isEmpty(): boolean {
        return this.inGuild.length === 0 && this.byChannel.size === 0 && this.byCategory.size === 0;
    }

    /**
     * The triggers listening where this message was posted, before any text filter, in
     * flow order. Each at most once: a trigger listens in one place.
     */
    matching(where: MessageWhere): MessageTriggerEntry[] {
        const found = [
            ...this.inGuild,
            ...(this.byChannel.get(where.channelId) ?? []),
            ...(where.parentChannelId ? (this.byChannel.get(where.parentChannelId) ?? []) : []),
            ...(where.categoryId ? (this.byCategory.get(where.categoryId) ?? []) : []),
        ];
        return found.sort((first, second) => first.position - second.position);
    }
}

/**
 * The enabled Message Sent triggers in each guild, in memory, so a message costs a map
 * lookup rather than a database read.
 *
 * - **Loaded lazily**, on a guild's first message, and a load in flight is shared by the
 *   messages that arrive while it runs.
 * - **A guild with none is held too**, as an empty entry — otherwise every message in a
 *   guild with no trigger would read the flows table again.
 * - **A load that fails holds nothing, and marks the guild** for
 *   {@link FLOW_MESSAGE_TRIGGER_READ_FAILURE_WINDOW_MS}: it is logged once, and until the
 *   window ends the guild's messages start nothing without reading or logging again. The
 *   first message after it tries again. One unreadable flow fails the whole read
 *   (`getByGuildId` validates every graph), so a guild's triggers are all or nothing.
 * - **Any committed flow write drops every guild** ({@link invalidate}, registered on
 *   `FlowsRepo` from `initFlows`), failure marks included, so a fixed graph is read on
 *   the next message rather than at the end of the window. A version counter makes a
 *   load that began before the write hand its result to the messages already waiting on
 *   it without keeping it — or marking the guild for it.
 *
 * Only writes made by this process are seen: a flow seeded from another process is
 * picked up at the next restart.
 */
export class MessageTriggerIndex {
    private readonly loaded = new Map<string, GuildMessageTriggers>();
    private readonly loading = new Map<string, Promise<GuildMessageTriggers | undefined>>();
    /** Guilds whose last load failed, with when a message may next read them (epoch ms). */
    private readonly retryAt = new Map<string, number>();
    private version = 0;

    constructor(private readonly repo: Pick<FlowsRepo, 'getByGuildId'> = flowsRepo) {}

    /**
     * The guild's triggers, loading them first if need be. Undefined when the load failed,
     * and — with no read — while the guild is still inside the window a failed load opened.
     */
    async forGuild(guildId: string, now: number = Date.now()): Promise<GuildMessageTriggers | undefined> {
        const held = this.loaded.get(guildId);
        if (held) return held;

        const pending = this.loading.get(guildId);
        if (pending) return pending;

        const retryAt = this.retryAt.get(guildId);
        if (retryAt !== undefined) {
            if (now < retryAt) return undefined;
            this.retryAt.delete(guildId);
        }

        const started = this.load(guildId, this.version, now);
        this.loading.set(guildId, started);
        return started;
    }

    /** Drop every guild, failure marks included, so the next message in each reads its flows again. */
    invalidate(): void {
        this.version += 1;
        this.loaded.clear();
        this.loading.clear();
        this.retryAt.clear();
    }

    private async load(guildId: string, version: number, now: number): Promise<GuildMessageTriggers | undefined> {
        try {
            const triggers = triggersFrom(await this.repo.getByGuildId(guildId));
            if (this.version === version) {
                this.loaded.set(guildId, triggers);
            }
            return triggers;
        } catch (error) {
            // Not marked when a write landed meanwhile: that write may be the fix, and the
            // next message should read it rather than wait out a window it did not earn.
            if (this.version === version) {
                this.retryAt.set(guildId, now + FLOW_MESSAGE_TRIGGER_READ_FAILURE_WINDOW_MS);
            }
            console.error(
                `[flows] Could not load the Message Sent triggers for guild ${guildId}; no message there starts a run ` +
                    `for the next ${FLOW_MESSAGE_TRIGGER_READ_FAILURE_WINDOW_MS / 1000}s, or until a flow is saved:`,
                error
            );
            return undefined;
        } finally {
            if (this.version === version) {
                this.loading.delete(guildId);
            }
        }
    }
}

/**
 * Every enabled Message Sent trigger in these flows, indexed by where it listens.
 *
 * Each node is parsed through `visibleNodeData`, as the executor and save-time validation
 * read it, so a channel left over from "A channel" cannot refuse an "Anywhere" trigger. A
 * node that still does not parse matches nothing rather than everything — firing on every
 * message because a channel was never picked is not what its author asked for.
 */
function triggersFrom(flows: readonly FlowEntity[]): GuildMessageTriggers {
    const inGuild: MessageTriggerEntry[] = [];
    const byChannel = new Map<string, MessageTriggerEntry[]>();
    const byCategory = new Map<string, MessageTriggerEntry[]>();
    const add = (target: Map<string, MessageTriggerEntry[]>, key: string, entry: MessageTriggerEntry): void => {
        target.set(key, [...(target.get(key) ?? []), entry]);
    };
    let position = 0;

    for (const flow of flows) {
        if (!flow.enabled) continue;

        for (const node of flow.graph.nodes) {
            const definition = isTriggerStartedBy(node.type, 'messageSent') ? getBlockDefinition(node.type) : undefined;
            if (!definition) continue;

            const parsed = messageSentConfigSchema.safeParse(visibleNodeData(definition.configFields, node.data));
            if (!parsed.success) continue;

            const config = parsed.data;
            const text = config.contains?.trim().toLowerCase();
            const entry: MessageTriggerEntry = {
                flowId: flow.flowId,
                graph: flow.graph,
                nodeId: node.id,
                position,
                ...(text ? { text } : {}),
            };
            position += 1;

            switch (config.where) {
                case 'anywhere':
                    inGuild.push(entry);
                    break;
                case 'channel':
                    if (config.channelId) add(byChannel, config.channelId, entry);
                    break;
                case 'category':
                    if (config.categoryId) add(byCategory, config.categoryId, entry);
                    break;
                default: {
                    const illegal: never = config.where;
                    throw new Error(`Unknown Message Sent scope ${JSON.stringify(illegal)}.`);
                }
            }
        }
    }

    return new GuildMessageTriggers(inGuild, byChannel, byCategory);
}

/** The process's one trigger index. */
export const messageTriggerIndex = new MessageTriggerIndex();
