import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Guild, GuildBasedChannel, GuildMember, GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ContextChannel } from '../../data/chatAgentConfigSchema';
import type { ChatToolContext } from '../chatToolContext';
import { getServerRulesTool, readContextChannelTool } from '../serverTools';

/**
 * `getServerRules` and `readContextChannel` over a server's configured context channels:
 * marked rules channels win over Discord's, and nothing configured is read for an asker who
 * cannot read it — not by name, not by id, not in a description or a not-found list.
 */

type FakeChannelSpec = {
    id: string;
    name: string;
    /** Member ids with View Channel and Read Message History. The bot always has both. */
    readers: readonly string[];
    /** Each message's text, newest first, as Discord returns them. */
    messages: readonly string[];
};

const BOT_ID = 'bot';

function fakeServer(specs: readonly FakeChannelSpec[], rulesChannelId: string | null) {
    const channels = new Map<string, GuildBasedChannel>();
    const guild = { id: 'guild', channels: { cache: channels }, members: { me: { id: BOT_ID } }, rulesChannel: null as unknown };
    for (const spec of specs) {
        const granted = (who: string): boolean => who === BOT_ID || spec.readers.includes(who);
        const fetched = new Map(
            spec.messages.map((content, index) => [
                `${spec.id}-${index}`,
                { content, attachments: new Map(), embeds: [], mentions: { members: new Map(), users: new Map(), roles: new Map() } },
            ])
        );
        const channel = {
            id: spec.id,
            name: spec.name,
            type: ChannelType.GuildText,
            isTextBased: () => true,
            isThread: () => false,
            permissionsFor: (who: { id: string }) => ({
                has: (flags: bigint | readonly bigint[]) =>
                    (Array.isArray(flags) ? flags : [flags]).every(
                        (flag: bigint) =>
                            (flag === PermissionFlagsBits.ViewChannel || flag === PermissionFlagsBits.ReadMessageHistory) &&
                            granted(who.id)
                    ),
            }),
            messages: { fetch: async () => fetched },
        };
        channels.set(spec.id, channel as unknown as GuildBasedChannel);
    }
    guild.rulesChannel = rulesChannelId ? channels.get(rulesChannelId) : null;

    const contextFor = (askerId: string, contextChannels: readonly ContextChannel[]): ChatToolContext => ({
        guild: guild as unknown as Guild,
        channel: channels.values().next().value as unknown as GuildTextBasedChannel,
        asker: { id: askerId, guild } as unknown as GuildMember,
        viewers: [{ id: askerId, guild } as unknown as GuildMember],
        viewersCanReadHistory: true,
        ticket: null,
        contextChannels,
        serverNotes: '',
        botRules: '',
    });
    return { contextFor };
}

const DISCORD_RULES = '100000000000000001';
const HOUSE_RULES = '100000000000000002';
const STAFF_RULES = '100000000000000003';
const KINK_101 = '100000000000000004';
const STAFF_NOTES = '100000000000000005';

const SERVER = fakeServer(
    [
        { id: DISCORD_RULES, name: 'rules', readers: ['vex', 'mod'], messages: ['Be nice.'] },
        { id: HOUSE_RULES, name: 'house-rules', readers: ['vex', 'mod'], messages: ['2. Ask before you DM.', '1. Consent first.'] },
        { id: STAFF_RULES, name: 'staff-rules', readers: ['mod'], messages: ['Mods: log every ban.'] },
        { id: KINK_101, name: 'kink-101', readers: ['vex', 'mod'], messages: ['Safewords are not optional.'] },
        { id: STAFF_NOTES, name: 'staff-notes', readers: ['mod'], messages: ['Vex is on thin ice.'] },
    ],
    DISCORD_RULES
);

const CONFIGURED: readonly ContextChannel[] = [
    { channelId: HOUSE_RULES, isRules: true },
    { channelId: STAFF_RULES, isRules: true },
    { channelId: KINK_101, isRules: false },
    { channelId: STAFF_NOTES, isRules: false },
];

type AnyTool = { execute?: (input: never, options: never) => unknown };

async function run(tool: AnyTool, input: object): Promise<unknown> {
    return tool.execute?.(input as never, { toolCallId: 'call-1', messages: [], context: undefined } as never);
}

describe('getServerRules', () => {
    it("falls back to Discord's rules channel when no context channel is marked as rules", async () => {
        const context = SERVER.contextFor('vex', [{ channelId: KINK_101, isRules: false }]);
        expect(await run(getServerRulesTool(context), {})).toEqual({
            found: true,
            sources: [{ channel: '#rules', rules: 'Be nice.' }],
        });
    });

    it('reads the marked rules channels instead, oldest message first, naming each', async () => {
        const context = SERVER.contextFor('mod', CONFIGURED);
        expect(await run(getServerRulesTool(context), {})).toEqual({
            found: true,
            sources: [
                { channel: '#house-rules', rules: '1. Consent first.\n\n2. Ask before you DM.' },
                { channel: '#staff-rules', rules: 'Mods: log every ban.' },
            ],
        });
    });

    it('leaves out a marked rules channel the asker cannot read', async () => {
        const context = SERVER.contextFor('vex', CONFIGURED);
        expect(await run(getServerRulesTool(context), {})).toEqual({
            found: true,
            sources: [{ channel: '#house-rules', rules: '1. Consent first.\n\n2. Ask before you DM.' }],
        });
    });

    it("does not fall back to Discord's rules channel when the asker can read none of the marked ones", async () => {
        const context = SERVER.contextFor('vex', [{ channelId: STAFF_RULES, isRules: true }]);
        expect(await run(getServerRulesTool(context), {})).toEqual({
            found: false,
            note: 'This server has no rules channel everyone here can see.',
        });
    });

    it('skips a marked channel that is gone from the server', async () => {
        const context = SERVER.contextFor('vex', [
            { channelId: '199999999999999999', isRules: true },
            { channelId: HOUSE_RULES, isRules: true },
        ]);
        expect(await run(getServerRulesTool(context), {})).toMatchObject({ sources: [{ channel: '#house-rules' }] });
    });
});

describe('readContextChannel', () => {
    it('reads a configured channel the asker can read, by name or id', async () => {
        const tool = readContextChannelTool(SERVER.contextFor('vex', CONFIGURED));
        const expected = { found: true, channel: '#kink-101', text: 'Safewords are not optional.' };
        expect(await run(tool, { channel: '#kink-101' })).toEqual(expected);
        expect(await run(tool, { channel: KINK_101 })).toEqual(expected);
        expect(await run(tool, { channel: `<#${KINK_101}>` })).toEqual(expected);
    });

    it('gives an asker who cannot read a configured channel nothing of it, by name or id', async () => {
        const tool = readContextChannelTool(SERVER.contextFor('vex', CONFIGURED));
        const nothing = { found: false, note: 'No context channel everyone here can read goes by that.', available: ['#kink-101'] };
        expect(await run(tool, { channel: 'staff-notes' })).toEqual(nothing);
        expect(await run(tool, { channel: STAFF_NOTES })).toEqual(nothing);
        expect(await run(tool, { channel: 'staff' })).toEqual(nothing);
    });

    it("names only the asker's readable channels in its description", () => {
        expect(readContextChannelTool(SERVER.contextFor('vex', CONFIGURED)).description).toContain('#kink-101');
        expect(readContextChannelTool(SERVER.contextFor('vex', CONFIGURED)).description).not.toContain('staff-notes');
        expect(readContextChannelTool(SERVER.contextFor('mod', CONFIGURED)).description).toContain('#staff-notes');
    });

    it('never reads a rules channel, or a channel that is not configured, though the asker can read both', async () => {
        const tool = readContextChannelTool(SERVER.contextFor('vex', CONFIGURED));
        expect(await run(tool, { channel: 'house-rules' })).toMatchObject({ found: false });
        expect(await run(tool, { channel: 'rules' })).toMatchObject({ found: false });
    });

    it('has nothing to read on a server with no context channels', async () => {
        const tool = readContextChannelTool(SERVER.contextFor('vex', []));
        expect(tool.description).toContain('none everyone here can read');
        expect(await run(tool, { channel: 'kink-101' })).toMatchObject({ found: false, available: [] });
    });
});
