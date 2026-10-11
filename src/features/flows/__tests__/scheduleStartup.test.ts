import { Events } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { TestDiscord, type ServerChannel, type ServerGuild } from '../../../shared/__tests__/support/testDiscord';
import { ACTION_SEND_MESSAGE } from '../blocks/actionSendMessage';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { TRIGGER_SCHEDULE } from '../blocks/triggerSchedule';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { flowSchedulesRepo } from '../data/flowSchedulesRepo';
import type { FlowScheduleEntity } from '../data/flowSchedulesSchema';
import { flowsRepo } from '../data/flowsRepo';
import { scheduleKey } from '../logic/reconcileGuildSchedules';

/**
 * Schedules at startup, end to end: the bot's own `DISCORD_CLIENT` against TestDiscord,
 * wired by the real `initFlows()`, on the real migrated schema.
 *
 * At ClientReady every guild is reconciled **before** the run scheduler starts, so the
 * first tick cannot fire a row reconcile has not looked at, and a flow saved before
 * schedules existed gets its row. A schedule missed while the bot was down keeps its
 * overdue time through that reconcile, and fires once on the first tick.
 *
 * One startup for the file, because there is only one to be had: `DISCORD_CLIENT` cannot
 * be handshaken twice, and `initFlows` is memoized.
 */

const schedulerStarts: Promise<FlowScheduleEntity[]>[] = [];
let watchedGuildId = '';

vi.mock('../engine/flowRunScheduler', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../engine/flowRunScheduler')>();
    return {
        ...actual,
        // What the table holds the moment the scheduler is asked to start.
        startFlowRunScheduler: (...args: Parameters<typeof actual.startFlowRunScheduler>) => {
            schedulerStarts.push(flowSchedulesRepo.listForGuild(watchedGuildId));
            actual.startFlowRunScheduler(...args);
        },
    };
});

const { initFlows } = await import('../initFlows');
const { resetFlowRunSchedulerForTests } = await import('../engine/flowRunScheduler');

const HOUR = 60 * 60_000;
const discord = new TestDiscord();

let unscheduled: { guild: ServerGuild; channel: ServerChannel; flowId: string };
let overdue: { guild: ServerGuild; channel: ServerChannel; flowId: string };

function postingGraph(channelId: string, message: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'nine', type: TRIGGER_SCHEDULE, position: { x: 0, y: 0 }, data: { repeat: 'daily', time: '09:00' } },
            { id: 'post', type: ACTION_SEND_MESSAGE, position: { x: 300, y: 0 }, data: { channelId, message } },
        ],
        edges: [{ id: 'nine-post', source: 'nine', target: 'post' }],
    };
}

function botSaid(guild: ServerGuild, channel: ServerChannel): string[] {
    return channel.messages.filter((message) => message.authorId === guild.bot.id).map((message) => message.content);
}

beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await ensureBlocksDiscovered();
    await migrateTestDatabase();

    // Saved before anything reconciled it — as a flow written before schedules existed.
    {
        const guild = discord.createGuild();
        const channel = guild.createTextChannel({ name: 'dungeon' });
        const flow = await flowsRepo.create({ guildId: guild.id, name: 'Never seen', graph: postingGraph(channel.id, 'first light'), enabled: true });
        unscheduled = { guild, channel, flowId: flow.flowId };
        watchedGuildId = guild.id;
    }

    // Reconciled in an earlier process, then missed while the bot was down.
    {
        const guild = discord.createGuild();
        const channel = guild.createTextChannel({ name: 'parlour' });
        const flow = await flowsRepo.create({ guildId: guild.id, name: 'Missed it', graph: postingGraph(channel.id, 'better late'), enabled: true });
        await flowSchedulesRepo.upsert({
            guildId: guild.id,
            flowId: flow.flowId,
            nodeId: 'nine',
            configKey: scheduleKey({ repeat: 'daily', time: '09:00' }, 'America/Los_Angeles'),
            nextRunAt: new Date(Date.now() - 3 * HOUR),
        });
        overdue = { guild, channel, flowId: flow.flowId };
    }

    await initFlows();
    await discord.start({ client: DISCORD_CLIENT });
    await vi.waitFor(() => expect(schedulerStarts).toHaveLength(1), { timeout: 10_000 });
}, 30_000);

afterAll(async () => {
    resetFlowRunSchedulerForTests();
    for (const event of [Events.ClientReady, Events.GuildMemberAdd, Events.GuildMemberRemove, Events.MessageReactionAdd] as const) {
        DISCORD_CLIENT.removeAllListeners(event);
    }
    vi.restoreAllMocks();
    await discord.destroy();
});

describe('schedules at startup', () => {
    it('reconciles every guild before the scheduler starts, giving an unseen flow its row', async () => {
        const [atStart] = await Promise.all(schedulerStarts);
        expect(atStart).toEqual([expect.objectContaining({ flowId: unscheduled.flowId, nodeId: 'nine' })]);
        expect(atStart[0]?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('fires a schedule missed while the bot was down once, on the first tick, and moves it past now', async () => {
        await vi.waitFor(() => expect(botSaid(overdue.guild, overdue.channel)).toEqual(['better late']), { timeout: 10_000 });

        const row = await database.selectFrom('flow_schedules').selectAll().where('flowId', '=', overdue.flowId).executeTakeFirst();
        expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
        expect(botSaid(unscheduled.guild, unscheduled.channel)).toEqual([]);
    });
});
