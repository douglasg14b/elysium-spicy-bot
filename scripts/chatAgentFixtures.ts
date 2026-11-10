/**
 * A made-up server for running the chat agent without Discord: a fake turn context and the
 * real tools (same names, descriptions and schemas) answering canned results. Shared by
 * `chatAgentEval.ts`; nothing here touches Discord or a database.
 */
import type { ModelMessage } from 'ai';
import { ChannelType } from 'discord.js';
import type { Guild, GuildBasedChannel, GuildMember, GuildTextBasedChannel } from 'discord.js';
import { historyToModelMessages, type HistoryMessage } from '../src/features/chat-agent/session/historyToModelMessages';
import { buildChatTools, type ChatTools } from '../src/features/chat-agent/tools/buildChatTools';
import type { ChatAgentConfig } from '../src/features/chat-agent/data/chatAgentConfigSchema';
import { BOT_FEATURE_REFUSALS, describeBotFeature } from '../src/features/chat-agent/tools/botFeatureTools';
import type { BotFeature } from '../src/features/chat-agent/tools/botFeatures';
import type { ChatToolContext } from '../src/features/chat-agent/tools/chatToolContext';
import type { FeatureSetup } from '../src/features/chat-agent/tools/featureSetup';
import type { StaffHelpAccess } from '../src/features/chat-agent/tools/staffAccess';
import { matchChannel } from '../src/features/chat-agent/tools/visibleChannels';
import type { TicketEntity } from '../src/features/tickets';

export const FIXTURE_ASKER_ID = '200000000000000001';
export const FIXTURE_ASKER_NAME = 'Vex';

/** The facts the canned tools answer with — also what a reply's accuracy is judged against. */
export const FIXTURE_FACTS = {
    rules: [
        '1. 18+ only. Verification is required before you can see NSFW channels.',
        '2. Consent is everything. No unsolicited NSFW, in channels or DMs.',
        '3. Ask before you DM anyone. Check their roles: "DMs closed" means no, "Ask to DM" means ask in #dm-requests first.',
        '4. No sharing other people’s pictures or personal info. Ever.',
        '5. Selfies go in #selfies (SFW) or #nsfw-selfies (verified only). Face pics are optional, consent of anyone else in frame is not.',
        '6. Kink-shaming is not a personality. Yuck quietly.',
        '7. Mods have final say. Disagree in a ticket, not in general.',
    ].join('\n'),
    memberCount: 1243,
    level: { level: 7, totalXp: 2140, xpToNextLevel: 260 },
};

/** The made-up server's channels. */
export const FIXTURE_CHANNELS = [
    { name: '#rules', id: '100000000000000001', category: 'Start Here', topic: 'Read these.' },
    { name: '#introductions', id: '100000000000000002', category: 'Start Here', topic: 'Say hi, pronouns, what brings you here.' },
    { name: '#get-verified', id: '100000000000000003', category: 'Start Here', topic: 'Open a verification ticket here.' },
    { name: '#general', id: '100000000000000004', category: 'Social', topic: 'Anything goes (within the rules).' },
    { name: '#selfies', id: '100000000000000005', category: 'Social', topic: 'SFW selfies. Compliments only.' },
    { name: '#nsfw-selfies', id: '100000000000000009', category: 'Verified', topic: 'NSFW selfies, verified members only.' },
    { name: '#dm-requests', id: '100000000000000006', category: 'Social', topic: 'Ask before you slide.' },
    { name: '#events', id: '100000000000000007', category: 'Meetups', topic: 'Munches, play parties, game nights.' },
    { name: '#tabletop', id: '100000000000000008', category: 'Nerd Stuff', topic: 'D&D, Pathfinder, and arguing about initiative.' },
];

/** The made-up server's roles, as `getServerInfo` lists them. */
const FIXTURE_ROLES = ['Owner', 'Moderator', 'Verified', 'Booster', 'DMs closed', 'Ask to DM', 'DMs open', 'Newcomer'];

/** The ticket channel `fixtureContext(true)` sits in. */
const TICKET_CHANNEL_NAME = 's42-verification-vex';

/**
 * Every reference in `reply` that breaks the names-only contract: any `<#…>`, `<@…>` or `<@&…>`
 * markup at all (the model never sees an id, so any it writes is made up), and `#name` for a
 * channel that does not exist. `#3`-style numbers are not references; `@name` is not checked.
 * The reply is checked as the model wrote it, before `linkReferences`.
 */
export function brokenReferences(reply: string): string[] {
    const channelNames = new Set([...FIXTURE_CHANNELS.map((channel) => channel.name.slice(1)), TICKET_CHANNEL_NAME]);
    const markup = /<[#@][^>\s]*>/g;
    const broken: string[] = [...reply.matchAll(markup)].map(([found]) => found);
    const withoutMarkup = reply.replace(markup, ' ');
    for (const [reference, name] of withoutMarkup.matchAll(/(?<![\p{L}\p{N}_&])#([\p{L}\p{N}_-]+)/gu)) {
        if (/^\d+$/.test(name)) continue;
        if (!channelNames.has(name.toLowerCase())) broken.push(reference);
    }
    return broken;
}

/** What each tool answers on the made-up server. Shapes match what the real tools return. */
function cannedResult(toolName: keyof ChatTools, input: unknown, inTicket: boolean, featureAccess: StaffHelpAccess): unknown {
    switch (toolName) {
        case 'getBotFeature': {
            const feature = (input as { feature: BotFeature }).feature;
            if (featureAccess !== 'allowed') return { answered: false, ...BOT_FEATURE_REFUSALS[featureAccess] };
            // As production runs it: with the dashboard on.
            return { answered: true, ...describeBotFeature(feature, 'https://brattybot.fettra.app'), setupHere: FIXTURE_FEATURE_SETUP[feature] ?? { setUp: false } };
        }
        case 'getServerRules':
            return { found: true, sources: [{ channel: '#rules', rules: FIXTURE_FACTS.rules }] };
        case 'readContextChannel':
            return { found: false, note: 'No context channel the asker can read goes by that.', available: [] };
        case 'getServerInfo':
            return {
                name: 'Elysium',
                description: 'A sex-positive, kink-friendly community for nerdy adults in the PNW.',
                memberCount: FIXTURE_FACTS.memberCount,
                createdAt: '2022-03-14T00:00:00.000Z',
                boostTier: 2,
                boostCount: 9,
                rulesChannels: ['#rules'],
                roles: FIXTURE_ROLES,
            };
        case 'listChannels':
            return {
                channels: FIXTURE_CHANNELS.map((channel) => ({
                    name: channel.name,
                    kind: 'text',
                    category: channel.category,
                    topic: channel.topic,
                })),
            };
        case 'getChannelInfo': {
            const query = String((input as { channel?: string }).channel ?? '');
            // The real tool's matching: id, <#id>, or name (exact before partial).
            const channel = matchChannel(
                FIXTURE_CHANNELS.map((candidate) => ({ ...candidate, name: candidate.name.slice(1) })),
                query
            );
            if (!channel) return { found: false, note: `No channel matching "${query}" that they can see.` };
            return {
                found: true,
                name: `#${channel.name}`,
                kind: 'text',
                category: channel.category,
                topic: channel.topic,
                nsfw: channel.name === 'nsfw-selfies',
                slowmodeSeconds: 0,
            };
        }
        case 'searchRecentMessages':
            return { matches: [] };
        case 'getMemberInfo':
            if (!isAsker(input)) return { found: false, note: `Nobody here matches "${String((input as { member?: string }).member)}".` };
            return {
                found: true,
                displayName: FIXTURE_ASKER_NAME,
                username: 'vex_irl',
                isBot: false,
                joinedAt: '2026-10-30T18:12:00.000Z',
                boostingSince: null,
                roles: inTicket ? ['Newcomer', 'Ask to DM'] : ['Verified', 'Ask to DM'],
            };
        case 'getUserLevel':
            if (!isAsker(input)) return { found: false, note: `Nobody here matches "${String((input as { member?: string }).member)}".` };
            return { found: true, displayName: FIXTURE_ASKER_NAME, ...FIXTURE_FACTS.level, hasAnyActivity: true };
        case 'getTicketInfo':
            return inTicket
                ? {
                      isTicket: true,
                      number: 42,
                      type: 'verification',
                      status: 'open',
                      title: 'Verification',
                      reason: 'New here, want to get verified',
                      openedFor: FIXTURE_ASKER_NAME,
                      claimedBy: null,
                      openedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
                  }
                : { isTicket: false };
        case 'stayQuiet':
            return { silent: true };
    }
    return { input };
}

/** The made-up server has one member worth asking about: the asker, by default or by name. */
function isAsker(input: unknown): boolean {
    const member = (input as { member?: string }).member;
    return !member || [FIXTURE_ASKER_NAME, FIXTURE_ASKER_ID, `<@${FIXTURE_ASKER_ID}>`, 'vex_irl'].some(
        (name) => name.toLowerCase() === member.trim().replace(/^@/, '').toLowerCase()
    );
}

/**
 * The made-up server as the output controls read it: its channels (everyone sees all of them),
 * Vex and Mara, and its roles — what `linkReferences` links names against.
 */
function fixtureGuild() {
    const guild = {
        id: 'guild',
        name: 'Elysium',
        channels: { cache: new Map<string, GuildBasedChannel>() },
        members: { cache: new Map<string, GuildMember>() },
        roles: { cache: new Map<string, { id: string; name: string; managed: boolean }>() },
    };
    const everyoneSees = { has: () => true };
    const channels = [
        ...FIXTURE_CHANNELS.map((channel) => ({ id: channel.id, name: channel.name.slice(1) })),
        { id: '100000000000000042', name: TICKET_CHANNEL_NAME },
    ];
    channels.forEach(({ id, name }, position) =>
        guild.channels.cache.set(id, {
            id,
            name,
            type: ChannelType.GuildText,
            position,
            parent: null,
            nsfw: name === 'nsfw-selfies',
            isThread: () => false,
            permissionsFor: () => everyoneSees,
        } as unknown as GuildBasedChannel)
    );
    const asker = { id: FIXTURE_ASKER_ID, displayName: FIXTURE_ASKER_NAME, user: { username: 'vex_irl', bot: false }, guild };
    guild.members.cache.set(asker.id, asker as unknown as GuildMember);
    guild.members.cache.set('200000000000000002', { id: '200000000000000002', displayName: 'Mara', user: { username: 'mara', bot: false }, guild } as unknown as GuildMember);
    FIXTURE_ROLES.forEach((name, index) => guild.roles.cache.set(`30000000000000000${index}`, { id: `30000000000000000${index}`, name, managed: false }));
    return { guild, asker: asker as unknown as GuildMember };
}

/**
 * What was posted, read back as people see it: each link shown as its `#name` or `@name`, the
 * way Discord renders it — so the checks and the judge read the message that went out.
 */
export function postedAsText(parts: readonly string[]): string {
    const { guild } = fixtureGuild();
    return parts
        .join('\n')
        .replace(/<#(\d+)>/g, (markup, id: string) => `#${guild.channels.cache.get(id)?.name ?? markup}`)
        .replace(/<@&(\d+)>/g, (markup, id: string) => `@${guild.roles.cache.get(id)?.name ?? markup}`)
        .replace(/<@!?(\d+)>/g, (markup, id: string) => `@${guild.members.cache.get(id)?.displayName ?? markup}`);
}

/** What the server's admins wrote on the dashboard, for a scenario that tests it. Unset is unwritten. */
export type FixtureGuidance = Partial<Pick<ChatAgentConfig, 'serverNotes' | 'botRules'>>;

export function fixtureContext(inTicket: boolean, guidance: FixtureGuidance = {}): ChatToolContext {
    const { guild, asker } = fixtureGuild();
    return {
        guild: guild as unknown as Guild,
        channel: guild.channels.cache.get(inTicket ? '100000000000000042' : '100000000000000004') as unknown as GuildTextBasedChannel,
        asker,
        viewers: [asker],
        viewersCanReadHistory: true,
        contextChannels: [],
        serverNotes: guidance.serverNotes ?? '',
        botRules: guidance.botRules ?? '',
        staffRoleIds: [],
        ticket: inTicket ? ({ ticketNumber: 42 } as unknown as TicketEntity) : null,
    };
}

/** How the made-up server has a few features set up, for a staff question about them. */
/** The setup the made-up server has, for the features a scenario asks about; the rest answer as never set up. */
const FIXTURE_FEATURE_SETUP: { readonly [Feature in BotFeature]?: FeatureSetup<Feature> } = {
    tickets: {
        setUp: true,
        panelPostedIn: '#get-verified',
        categories: { 'open tickets': 'Tickets', 'claimed tickets': 'Claimed', 'closed tickets': 'not set' },
        moderationRoles: ['@Mods'],
        ticketTypes: [
            { name: 'Support', claimedOnOpen: true },
            { name: 'Verification', claimedOnOpen: false },
        ],
    },
    warnings: { modLogChannel: 'not set' },
    flows: { flows: [{ name: 'Welcome', on: true, startsOn: ['Member Joins'], journey: 'Onboarding' }], journeys: ['Onboarding'] },
};

/**
 * The real tools — same names, descriptions and schemas — answering from {@link cannedResult}.
 * `featureAccess` is what `getBotFeature` decides for this asker and channel: the made-up
 * asker is not staff unless a scenario says so.
 */
export function fixtureTools(context: ChatToolContext, featureAccess: StaffHelpAccess = 'askerNotStaff'): ChatTools {
    const real = buildChatTools(context);
    const inTicket = !!context.ticket;
    const names = Object.keys(real) as (keyof ChatTools)[];
    return Object.fromEntries(
        names.map((name) => [name, { ...real[name], execute: async (input: unknown) => cannedResult(name, input, inTicket, featureAccess) }])
    ) as unknown as ChatTools;
}

/** A conversation: earlier `[author, text]` lines, then the asker @-ing the bot — through the real history formatting. */
export function fixtureConversation(before: readonly (readonly [string, string])[], question: string): ModelMessage[] {
    const message = (id: string, authorName: string, content: string, minutesAgo: number, isBeingAnswered: boolean): HistoryMessage => ({
        id,
        authorName,
        isFromThisBot: authorName === 'BrattyBot',
        isFromOtherBot: false,
        content,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
        replyToAuthorName: undefined,
        isBeingAnswered,
    });
    const history = [
        ...before.map(([author, text], index) => message(`before-${index}`, author, text, before.length - index + 1, false)),
        message('question', FIXTURE_ASKER_NAME, `@BrattyBot ${question}`, 0, true),
    ];
    return historyToModelMessages(history, () => undefined, FIXTURE_ASKER_ID);
}
