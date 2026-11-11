import type { Guild } from 'discord.js';
import { birthdayConfigRepo } from '../../birthday-tracker/data/birthdayConfigRepo';
import { flashChatRepo } from '../../flash-chat/data/flashChatRepo';
import { formatFlashChatTimeout } from '../../flash-chat/logic/flashChatNotices';
import { flowsRepo } from '../../flows/data/flowsRepo';
import type { FlowGraph } from '../../flows/data/flowGraph';
import { getBlockDefinition } from '../../flows/blocks/registry';
import { levelingConfigRepo } from '../../leveling/data/levelingConfigRepo';
import { flowJourneyLinksRepo } from '../../provisioning/data/flowJourneyLinksRepo';
import { journeysRepo } from '../../provisioning/data/journeysRepo';
import { ticketingRepo } from '../../tickets/data/ticketingRepo';
import { isBoundTicketCategory, TICKET_CATEGORY_SLOTS, type TicketCategoryBinding } from '../../tickets/data/ticketingSchema';
import { describeCategorySlot } from '../../tickets/logic/ticketCategories';
import { listTicketTypes } from '../../tickets/logic/ticketTypes';
import { warningsConfigRepo } from '../../warnings/data/warningsConfigRepo';
import { guildSettingsRepo } from '../../../features-system/guild-settings';
import type { BotFeature } from './botFeatures';
import type { ChatToolContext } from './chatToolContext';
import { everyoneCanSee, type Viewers } from './visibleChannels';

/** At most this many flows are listed; a server with more is told how many were left out. */
const FLOW_LIST_LIMIT = 30;

/**
 * How one server has a feature set up, as names a person reads — never ids. Read from the
 * database and the guild's cache only. A channel is named only when every reader can see it,
 * as every channel the agent reveals is (`visibleChannels.ts`).
 */
export type FeatureSetupReader = (context: ChatToolContext) => Promise<Readonly<Record<string, unknown>>>;

/** What `FEATURE_SETUP` answers for one feature. */
export type FeatureSetup<Feature extends BotFeature> = Awaited<ReturnType<(typeof FEATURE_SETUP)[Feature]>>;

const NOT_SET = 'not set';

function channelLabel(guild: Guild, viewers: Viewers, channelId: string | null | undefined): string {
    if (!channelId) return NOT_SET;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return 'a channel that has been deleted';
    return everyoneCanSee(viewers, channel) ? `#${channel.name}` : "a channel not everyone here can see";
}

function roleLabels(guild: Guild, roleIds: readonly string[]): string[] {
    return roleIds.map((roleId) => {
        const role = guild.roles.cache.get(roleId);
        return role ? `@${role.name}` : 'a role that has been deleted';
    });
}

/**
 * A ticket category slot: its category by id, as `channelLabel` names any channel. A slot
 * with a name and no category behind it stops tickets, and is said so — its name is only
 * the one it would be created under.
 */
function ticketCategoryLabel(guild: Guild, viewers: Viewers, binding: TicketCategoryBinding | undefined): string {
    if (!binding) return NOT_SET;
    if (!isBoundTicketCategory(binding)) return 'not linked — tickets stop until it is linked on Tickets config';
    return channelLabel(guild, viewers, binding.discordId);
}

/** The trigger blocks a flow starts from, by their builder names. A type this build has no block for is named as stored. */
function triggerLabels(graph: Pick<FlowGraph, 'nodes'>): string[] {
    return graph.nodes.flatMap((node) => {
        const block = getBlockDefinition(node.type);
        if (block) return block.kind === 'trigger' ? [block.label] : [];
        return node.type.startsWith('trigger.') ? [node.type] : [];
    });
}

export const FEATURE_SETUP = {
    birthdays: async ({ guild, viewers }) => {
        const config = await birthdayConfigRepo.getByGuildId(guild.id);
        if (!config) return { setUp: false };
        return {
            setUp: true,
            announcementChannel: channelLabel(guild, viewers, config.announcementChannelId),
            contextChannel: channelLabel(guild, viewers, config.contextChannelId),
        };
    },
    flashChat: async ({ guild, viewers }) => {
        const configs = await flashChatRepo.listByGuild(guild.id);
        return {
            channels: configs.map((config) => ({
                channel: channelLabel(guild, viewers, config.channelId),
                on: config.enabled,
                deletesAfter: formatFlashChatTimeout(config.timeoutSeconds),
                keepsPinned: config.preservePinned,
                leavesOlderMessages: config.preserveHistory,
            })),
        };
    },
    flows: async ({ guild }) => {
        const [flows, journeys, links] = await Promise.all([
            flowsRepo.getByGuildId(guild.id),
            journeysRepo.listNamesByGuildId(guild.id),
            flowJourneyLinksRepo.listLinksForGuild(guild.id),
        ]);
        const journeyNames = new Map(journeys.map((journey) => [journey.journeyKey, journey.name]));
        const journeyOf = new Map(links.map((link) => [link.flowId, journeyNames.get(link.journeyKey) ?? null]));
        return {
            flows: flows.slice(0, FLOW_LIST_LIMIT).map((flow) => ({
                name: flow.name,
                on: flow.enabled,
                startsOn: triggerLabels(flow.graph),
                journey: journeyOf.get(flow.flowId) ?? null,
            })),
            ...(flows.length > FLOW_LIST_LIMIT ? { notListed: flows.length - FLOW_LIST_LIMIT } : {}),
            journeys: journeys.map((journey) => journey.name),
        };
    },
    leveling: async ({ guild, viewers }) => {
        const config = await levelingConfigRepo.getByGuildId(guild.id);
        if (!config) return { on: false };
        return { on: config.enabled, levelUpsAnnouncedIn: channelLabel(guild, viewers, config.notificationChannelId) };
    },
    tickets: async ({ guild, viewers }) => {
        const entity = await ticketingRepo.get(guild.id);
        if (!entity) return { setUp: false };
        const { config } = entity;
        const types = listTicketTypes(config);
        // The server's three slots, then each type's own, which win over the server's for that type.
        const slots = [
            ...TICKET_CATEGORY_SLOTS.map((slot) => [describeCategorySlot(slot), config.categories[slot]] as const),
            ...types.flatMap((type) =>
                TICKET_CATEGORY_SLOTS.flatMap((slot) => {
                    const own = config.typeCategories.get(type.type)?.[slot];
                    return own ? [[describeCategorySlot(slot, type.label), own] as const] : [];
                })
            ),
        ];
        return {
            setUp: true,
            panelPostedIn: config.modTicketsDeployed ? channelLabel(guild, viewers, config.modTicketsDeployedChannelId) : NOT_SET,
            categories: Object.fromEntries(slots.map(([label, binding]) => [label, ticketCategoryLabel(guild, viewers, binding)])),
            moderationRoles: roleLabels(guild, config.moderationRoles),
            ticketTypes: types.map((type) => ({ name: type.label, claimedOnOpen: type.autoClaimOnOpen })),
        };
    },
    warnings: async ({ guild, viewers }) => {
        const config = await warningsConfigRepo.getByGuildId(guild.id);
        return { modLogChannel: channelLabel(guild, viewers, config?.modChannelId) };
    },
    chatAgent: async ({ guild, viewers, contextChannels, botRules, serverNotes, staffRoleIds, introsChannelId }) => ({
        contextChannels: contextChannels.map((entry) => ({
            channel: channelLabel(guild, viewers, entry.channelId),
            rulesChannel: entry.isRules,
        })),
        introsChannel: channelLabel(guild, viewers, introsChannelId),
        // The turn's: the Chat Agent page's own staff roles, else Server Settings'.
        staffRoles: roleLabels(guild, staffRoleIds),
        botRules: botRules || NOT_SET,
        serverNotes: serverNotes || NOT_SET,
    }),
    // Server Settings' own staff roles, read here: the turn's are the chat agent's, which may differ.
    serverSettings: async ({ guild }) => {
        const [staffRoleIds, timeZone] = await Promise.all([guildSettingsRepo.getStaffRoleIds(guild.id), guildSettingsRepo.getTimeZone(guild.id)]);
        return {
            staffRoles: roleLabels(guild, staffRoleIds),
            timeZone: timeZone.chosen ?? `${timeZone.effective} (the default; not chosen)`,
        };
    },
} as const satisfies Readonly<Record<BotFeature, FeatureSetupReader>>;
