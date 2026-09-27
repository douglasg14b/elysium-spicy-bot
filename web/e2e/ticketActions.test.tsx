import { screen, waitFor, within } from '@testing-library/react';
import { ChannelType, MessageType, type Client, type PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { block as openTicketBlock } from '../../src/features/flows/blocks/actionOpenTicket';
import type { FlowVariableValue } from '../../src/features/flows/blocks/types';
import { defaultTicketTypes } from '../../src/features/tickets/data/defaultTicketTypes';
import { ticketingRepo } from '../../src/features/tickets/data/ticketingRepo';
import type { TicketEntity } from '../../src/features/tickets/data/ticketsSchema';
import { getTicket } from '../../src/features/tickets/ticketService';
import {
    TestDiscord,
    type OverwriteView,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
    type ServerMessageView,
    type ServerRole,
} from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp, type DashboardOperator } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * Working tickets from the dashboard, end to end: the list and detail pages drive the
 * real ticket routes, `applyTicketTransition` commits the row and makes Discord follow,
 * and the assertions land on both sides — what the page says, and what TestDiscord holds
 * for the channel, its overwrites and its messages.
 *
 * **Tickets are opened by the product's own open path**, the `action.openTicket` flow
 * block, run directly because no flow run is under test. It is the one path that opens a
 * ticket without an interaction, and it does everything a real open does: allocates the
 * number, creates the category and channel, posts and pins the state message and records
 * its id. So every action here re-renders a message the product posted, rather than one
 * a test invented.
 *
 * **The config is deployed through `ticketingRepo` directly**, the way
 * `/deploy-ticket-system` writes it, because no dashboard route creates the row. Everything
 * after that goes through the real config routes.
 *
 * The type used throughout is declared here rather than taken from the shipped two, both of
 * whose name templates start with a capital (`S{{####}}`, `V{{####}}`). Discord lowercases
 * text channel names, TestDiscord refuses to guess how, and the shipped `support` type
 * auto-claims — which a flow-opened ticket, having no opener, can never do.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR_NAME = 'mistress_of_queues';
const TYPE_KEY = 'aftercare';
const TYPE_LABEL = 'Aftercare Check-in';
/** Auto-claims on open, which a flow-opened ticket cannot do: it has no opener to claim it. */
const AUTO_CLAIM_TYPE_KEY = 'aftercare-urgent';

const CATEGORIES = {
    open: 'Tickets — Open',
    claimed: 'Tickets — Claimed',
    closed: 'Tickets — Closed',
} as const;

const PARTICIPANT_PERMISSIONS = { view: true, send: true, readHistory: true, manageMessages: false };
const STAFF_PERMISSIONS = { view: true, send: true, readHistory: true, manageMessages: true };

/** The four flags `toPermissionOverwrite` maps a type's permissions onto, as TestDiscord sorts them. */
const STAFF_FLAGS: readonly PermissionsString[] = ['ManageMessages', 'ReadMessageHistory', 'SendMessages', 'ViewChannel'];
const PARTICIPANT_ALLOW: readonly PermissionsString[] = ['ReadMessageHistory', 'SendMessages', 'ViewChannel'];

/** The Discord-side names `ticketButtonConfigs` gives the five controls, in the order they render. */
const BUTTONS = [
    'ticket_claim_button',
    'ticket_unclaim_button',
    'ticket_close_button',
    'ticket_reopen_button',
    'ticket_delete_button',
] as const;

interface TicketGuild {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly api: SeedApi;
    readonly moderators: ServerRole;
    readonly subject: ServerMember;
    readonly operatorMember: ServerMember;
    readonly operator: DashboardOperator;
}

interface OpenedTicket {
    readonly ticket: TicketEntity;
    readonly channel: ServerChannel;
    readonly stateMessageId: string;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/**
 * A guild with tickets deployed and configured: three categories by name, one moderation
 * role, and the aftercare type.
 *
 * The operator is a guild member holding the moderation role, as a real dashboard user
 * working tickets would be. That matters on Discord's side: a claim writes a member
 * overwrite for the claimer, and whether Discord accepts one for a user outside the guild
 * is not something TestDiscord models.
 */
async function guildWithTickets(): Promise<TicketGuild> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    const moderators = guild.createRole({ name: 'Dungeon Monitors' });
    const operatorMember = guild.createMember({ username: OPERATOR_NAME, roles: [moderators] });
    const subject = guild.createMember({ username: 'rope_bunny' });
    const desk = guild.createTextChannel({ name: 'ticket-desk' });
    const client = await discord.start();
    const operator: DashboardOperator = { id: operatorMember.id, username: OPERATOR_NAME };

    // The panel `/deploy-ticket-system` would post, stood in for by a real message so the
    // config names one Discord holds. Nothing here renders or reads it.
    const liveDesk = discord.clientGuild(guild).channels.cache.get(desk.id);
    if (liveDesk?.type !== ChannelType.GuildText) throw new Error('The client holds no ticket desk.');
    const panel = await liveDesk.send({ content: 'Need a hand, a hug or a referee? Open a ticket.' });

    await ticketingRepo.upsert({
        guildId: guild.id,
        config: JSON.stringify({
            modTicketsDeployed: true,
            modTicketsDeployedChannelId: desk.id,
            modTicketsDeployedMessageId: panel.id,
            supportTicketCategoryName: '',
            claimedTicketCategoryName: '',
            closedTicketCategoryName: '',
            moderationRoles: [],
            ticketTypes: defaultTicketTypes(),
        }),
        ticketNumberInc: 0,
        entityVersion: 1,
    });

    const faults: string[] = [];
    const api = createSeedApi(buildDashboardApp({ client, operator, onFault: (fault) => faults.push(fault) }), discord);
    const guildPath = `/api/guilds/${guild.id}`;
    await api.send('PUT', `${guildPath}/config/tickets`, {
        supportTicketCategoryName: CATEGORIES.open,
        claimedTicketCategoryName: CATEGORIES.claimed,
        closedTicketCategoryName: CATEGORIES.closed,
        moderationRoles: [moderators.id],
    });
    await api.send('PUT', `${guildPath}/config/tickets/types/${TYPE_KEY}`, {
        label: TYPE_LABEL,
        nameTemplate: 'aftercare-{{####}}-{{subject}}',
        permissions: { subject: PARTICIPANT_PERMISSIONS, opener: PARTICIPANT_PERMISSIONS, staff: STAFF_PERMISSIONS },
        autoClaimOnOpen: false,
    });
    await api.send('PUT', `${guildPath}/config/tickets/types/${AUTO_CLAIM_TYPE_KEY}`, {
        label: 'Urgent Aftercare',
        nameTemplate: 'urgent-{{####}}-{{subject}}',
        permissions: { subject: PARTICIPANT_PERMISSIONS, opener: PARTICIPANT_PERMISSIONS, staff: STAFF_PERMISSIONS },
        autoClaimOnOpen: true,
    });
    expect(faults).toEqual([]);

    return { discord, client, guild, api, moderators, subject, operatorMember, operator };
}

/** Open a ticket about the guild's subject, through `action.openTicket`. Aftercare unless told otherwise. */
async function openTicket(ticketGuild: TicketGuild, title: string, ticketType: string = TYPE_KEY): Promise<OpenedTicket> {
    const { discord, client, guild, subject } = ticketGuild;
    const liveGuild = discord.clientGuild(guild);
    const liveSubject = liveGuild.members.cache.get(subject.id);
    if (!liveSubject) throw new Error('The client holds no member for the subject.');

    const outputs = new Map<string, FlowVariableValue>();
    const outcome = await openTicketBlock.run(
        { ticketType, title, reason: 'Checking in after a heavy scene. Nobody is in trouble.' },
        {
            client,
            guild: liveGuild,
            subject: liveSubject,
            variables: {},
            runId: `e2e-${title}`,
            nodeId: 'open-ticket',
            setOutput: (key, value) => outputs.set(key, value),
        }
    );
    expect(outcome).toEqual({ kind: 'continue' });
    discord.flushGateway();

    const ticket = await getTicket(Number(outputs.get('ticketId')));
    if (!ticket?.channelId || !ticket.stateMessageId) {
        throw new Error(`"${title}" did not open with a channel and a state message.`);
    }
    return { ticket, channel: guild.channel(ticket.channelId), stateMessageId: ticket.stateMessageId };
}

/** The category Discord holds under this name. */
function categoryNamed(ticketGuild: TicketGuild, name: string): ServerChannel {
    const found = ticketGuild.discord
        .clientGuild(ticketGuild.guild)
        .channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === name);
    if (!found) throw new Error(`Discord holds no category named "${name}".`);
    return ticketGuild.guild.channel(found.id);
}

/** The value of one field on the state message's embed. */
function embedField(message: ServerMessageView, name: string): string | undefined {
    return message.embeds[0]?.fields?.find((field) => field.name === name)?.value;
}

/** Which of the state message's buttons are live, by custom id. */
function enabledButtons(message: ServerMessageView): string[] {
    return (message.components[0]?.components ?? []).flatMap((button) =>
        'custom_id' in button && !button.disabled ? [button.custom_id] : []
    );
}

/** The newest message the bot wrote itself, skipping the notices Discord posts. */
function latestAnnouncement(channel: ServerChannel): ServerMessageView | undefined {
    return channel.messages.filter((message) => message.type === MessageType.Default).at(-1);
}

/** The overwrites the type's model plus the bot's own entry produce, before any claim or close. */
function baseOverwrites(ticketGuild: TicketGuild): OverwriteView[] {
    return [
        { id: ticketGuild.guild.id, type: 'role', allow: [], deny: ['ViewChannel'] },
        { id: ticketGuild.subject.id, type: 'member', allow: [...PARTICIPANT_ALLOW], deny: ['ManageMessages'] },
        { id: ticketGuild.guild.bot.id, type: 'member', allow: [...STAFF_FLAGS], deny: [] },
        { id: ticketGuild.moderators.id, type: 'role', allow: [...STAFF_FLAGS], deny: [] },
    ];
}

/** The tickets list's row for a ticket, found by its title. */
async function ticketRow(title: string): Promise<HTMLElement> {
    const cell = await screen.findByText(title, { selector: 'td *' });
    const row = cell.closest('tr');
    if (!row) throw new Error(`"${title}" is not inside a table row.`);
    return row;
}

/** The value the detail page shows under one of its person labels. */
function personRow(label: 'Subject' | 'Opened by' | 'Claimed by'): HTMLElement {
    const row = screen.getByText(label).parentElement;
    if (!row) throw new Error(`"${label}" has no row around it.`);
    return row;
}

describe('claiming a ticket from the tickets list', () => {
    it('records the operator as claimer, moves the channel to the claimed category, and says so in Discord without a ping', async () => {
        const ticketGuild = await guildWithTickets();
        const title = "Aftercare after Saturday's rope scene";
        const opened = await openTicket(ticketGuild, title);
        const { discord, operator, operatorMember } = ticketGuild;

        // Where the open left things, so the claim below is seen to move them.
        expect(opened.channel.name).toBe('aftercare-0001-ropebunny');
        expect(opened.channel.parentId).toBe(categoryNamed(ticketGuild, CATEGORIES.open).id);
        expect(embedField(opened.channel.message(opened.stateMessageId), '📊 Status')).toBe('🟢 Open — unclaimed');

        installDashboardApi(ticketGuild.client, operator);
        const { user } = renderDashboard('/tickets');
        const row = await ticketRow(title);
        expect(within(row).getByText('Unclaimed')).toBeTruthy();
        await user.click(within(row).getByRole('button', { name: 'Claim' }));

        // The page's side: the row now names the operator and offers the claimed actions.
        await waitFor(() => expect(within(row).getByText(OPERATOR_NAME)).toBeTruthy());
        expect(within(row).getByRole('button', { name: 'Release' })).toBeTruthy();
        expect(within(row).queryByRole('button', { name: 'Claim' })).toBeNull();
        expect(await screen.findByText('#0001 claimed.')).toBeTruthy();
        expect(screen.queryByText('Discord did not keep up')).toBeNull();

        // Discord's side: the channel sits in the claimed category, the operator holds the
        // staff arrangement in their own right, and nothing else moved.
        discord.flushGateway();
        expect(opened.channel.parentId).toBe(categoryNamed(ticketGuild, CATEGORIES.claimed).id);
        expect(opened.channel.overwrites).toEqual([
            ...baseOverwrites(ticketGuild),
            { id: operatorMember.id, type: 'member', allow: [...STAFF_FLAGS], deny: [] },
        ]);

        // The state message the open posted was edited in place, not replaced.
        const stateMessage = opened.channel.message(opened.stateMessageId);
        expect(stateMessage.edited).toBe(true);
        expect(stateMessage.pinned).toBe(true);
        expect(embedField(stateMessage, '📊 Status')).toBe(`🔒 Open — claimed by <@${operator.id}>`);
        expect(enabledButtons(stateMessage)).toEqual([BUTTONS[1], BUTTONS[2], BUTTONS[4]]);

        // And one announcement, naming the operator as a dashboard actor rather than pinging them.
        expect(opened.channel.messages.map((message) => message.type)).toEqual([
            MessageType.Default,
            MessageType.ChannelPinnedMessage,
            MessageType.Default,
        ]);
        expect(latestAnnouncement(opened.channel)?.content).toBe(
            `✋ **Ticket Claimed**\nThis ticket has been claimed by **${OPERATOR_NAME}** (via the dashboard).`
        );
        expect(latestAnnouncement(opened.channel)?.content).not.toContain('<@');
    });
});

describe('releasing and closing a ticket from its detail page', () => {
    it('returns a released ticket to the open category, then closes it with the subject shut out', async () => {
        const ticketGuild = await guildWithTickets();
        const title = 'Rope burn questions after the Friday demo';
        const opened = await openTicket(ticketGuild, title);
        const { discord, operator, operatorMember } = ticketGuild;
        // Claimed through the same route the page calls, so Discord agrees with the row
        // before the release starts.
        await ticketGuild.api.send('POST', `/api/guilds/${ticketGuild.guild.id}/tickets/${opened.ticket.id}/claim`);
        expect(opened.channel.parentId).toBe(categoryNamed(ticketGuild, CATEGORIES.claimed).id);

        installDashboardApi(ticketGuild.client, operator);
        const { user } = renderDashboard(`/tickets/${opened.ticket.id}`);
        expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
        expect(within(personRow('Claimed by')).getByText(OPERATOR_NAME)).toBeTruthy();

        // -- Release --
        await user.click(screen.getByRole('button', { name: 'Release' }));

        await waitFor(() =>
            expect(within(personRow('Claimed by')).getByText('Unclaimed — nobody has picked this up')).toBeTruthy()
        );
        expect(screen.getByRole('button', { name: 'Claim' })).toBeTruthy();
        expect(await screen.findByText('#0001 released.')).toBeTruthy();

        discord.flushGateway();
        expect(opened.channel.parentId).toBe(categoryNamed(ticketGuild, CATEGORIES.open).id);
        expect(opened.channel.overwriteFor(operatorMember)).toBeUndefined();
        expect(opened.channel.overwrites).toEqual(baseOverwrites(ticketGuild));
        const released = opened.channel.message(opened.stateMessageId);
        expect(embedField(released, '📊 Status')).toBe('🟢 Open — unclaimed');
        expect(enabledButtons(released)).toEqual([BUTTONS[0], BUTTONS[2], BUTTONS[4]]);
        expect(latestAnnouncement(opened.channel)?.content).toBe(
            `↩️ **Ticket Released**\nThis ticket has been released by **${OPERATOR_NAME}** (via the dashboard) and is up for grabs.`
        );

        // -- Close --
        await user.click(screen.getByRole('button', { name: 'Close' }));

        await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy());
        expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
        expect(screen.getByText('closed', { selector: '.mantine-Badge-label' })).toBeTruthy();
        expect(screen.getByText('Closed', { selector: 'p' })).toBeTruthy();
        expect(screen.queryByText('Discord did not keep up')).toBeNull();

        discord.flushGateway();
        expect(opened.channel.parentId).toBe(categoryNamed(ticketGuild, CATEGORIES.closed).id);
        // Closing drops the subject's overwrite outright, so `@everyone`'s denial is what
        // they are left with; staff and the bot keep what the type gives them.
        expect(opened.channel.overwriteFor(ticketGuild.subject)).toBeUndefined();
        expect(opened.channel.overwrites).toEqual(
            baseOverwrites(ticketGuild).filter((overwrite) => overwrite.id !== ticketGuild.subject.id)
        );
        const closed = opened.channel.message(opened.stateMessageId);
        expect(embedField(closed, '📊 Status')).toBe('🔴 Closed');
        expect(closed.embeds[0]?.color).toBe(0xff0000);
        expect(enabledButtons(closed)).toEqual([BUTTONS[3], BUTTONS[4]]);
        expect(latestAnnouncement(opened.channel)?.content).toBe(
            `🔒 **Ticket Closed**\nThis ticket has been closed by **${OPERATOR_NAME}** (via the dashboard).`
        );
    });
});

describe('acting on a ticket whose channel was deleted in Discord', () => {
    it('commits the claim without a warning, and asks Discord nothing but where the channel went', async () => {
        const ticketGuild = await guildWithTickets();
        const title = 'Check-in for a scene that got cut short';
        const opened = await openTicket(ticketGuild, title);
        const { discord, operator } = ticketGuild;
        // Somebody tidies the channel away by hand. The ticket row still points at it.
        opened.channel.delete();
        const requestsBefore = discord.requests.length;

        installDashboardApi(ticketGuild.client, operator);
        const { user } = renderDashboard(`/tickets/${opened.ticket.id}`);
        expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Claim' }));

        // The record is the truth, so the claim lands. `resolveChannel` treats a channel
        // Discord no longer holds as "nothing to sync", not as a failed sync, so there is
        // no warning: the channel cannot be showing anybody anything.
        await waitFor(() => expect(within(personRow('Claimed by')).getByText(OPERATOR_NAME)).toBeTruthy());
        expect(await screen.findByText('#0001 claimed.')).toBeTruthy();
        expect(screen.queryByText('Discord did not keep up')).toBeNull();
        expect((await getTicket(opened.ticket.id))?.claimerId).toBe(operator.id);

        // One question to Discord, answered 10003, and then nothing: no category made for
        // a channel that is not there, no edit, no announcement.
        expect(discord.requests.slice(requestsBefore)).toEqual([
            { method: 'GET', path: `/channels/${opened.channel.id}`, body: undefined, status: 404 },
        ]);
    });

    // Skipped, not deleted: it fails today. Nothing clears `channelId` when Discord answers
    // 10003 or a channel is deleted, so the page keeps linking to it. How the product should
    // learn the channel is gone (on the next action, from the gateway, or both) is an
    // open decision; this is the promise either answer has to keep.
    it.skip('stops offering a link to the channel once Discord has said it is gone', async () => {
        const ticketGuild = await guildWithTickets();
        const title = 'Check-in whose channel somebody tidied away';
        const opened = await openTicket(ticketGuild, title);
        opened.channel.delete();

        installDashboardApi(ticketGuild.client, ticketGuild.operator);
        const { user } = renderDashboard(`/tickets/${opened.ticket.id}`);
        expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Claim' }));
        await waitFor(() => expect(within(personRow('Claimed by')).getByText(OPERATOR_NAME)).toBeTruthy());

        // The page's own promise: "The channel is gone — deleted in Discord, by this bot or
        // by hand." The bot has just been told exactly that by Discord.
        expect(screen.queryByRole('link', { name: 'Open the channel in Discord' })).toBeNull();
        expect(screen.getByText(/The channel is gone — deleted in Discord, by this bot or by hand/)).toBeTruthy();
    });
});

describe('a flow opening a ticket of a type that auto-claims', () => {
    it('files it in the open category, because nobody claimed it', async () => {
        const ticketGuild = await guildWithTickets();

        const opened = await openTicket(ticketGuild, 'Urgent check-in the onboarding flow filed', AUTO_CLAIM_TYPE_KEY);

        // Auto-claim needs an opener to claim for, and a flow is nobody. The channel belongs
        // where an unclaimed ticket's channel goes, which is where a claim then moves it from.
        expect(opened.ticket.claimerId).toBeNull();
        expect(opened.channel.parentId).toBe(categoryNamed(ticketGuild, CATEGORIES.open).id);
    });
});

describe('declaring a ticket type from the config page', () => {
    it('adds the type through the editor, and the list offers it as a filter that narrows by it', async () => {
        const ticketGuild = await guildWithTickets();
        const dashboard = installDashboardApi(ticketGuild.client, ticketGuild.operator);
        const { user } = renderDashboard('/tickets/config');

        await user.click(await screen.findByRole('button', { name: 'Add type' }));
        const editor = await screen.findByRole('dialog', { name: 'New ticket type' });
        await user.type(within(editor).getByRole('textbox', { name: /^Key/ }), 'impact-play');
        await user.type(within(editor).getByRole('textbox', { name: /^Label/ }), 'Impact Play Debrief');
        const template = within(editor).getByRole('textbox', { name: /^Channel name template/ });
        await user.clear(template);
        // `{{` is user-event's own escape for a literal brace.
        await user.type(template, 'impact-{{{{####}}-{{{{subject}}');
        await user.click(within(editor).getByRole('button', { name: 'Save type' }));

        expect(await screen.findByText('“Impact Play Debrief” is on the menu.')).toBeTruthy();
        const typeRow = (await screen.findByText('impact-play', { selector: 'td *' })).closest('tr');
        if (!typeRow) throw new Error('The new type is not in a table row.');
        expect(within(typeRow).getByText('Impact Play Debrief')).toBeTruthy();
        expect(within(typeRow).getByText('impact-{{####}}-{{subject}}')).toBeTruthy();

        // The list, reached the way an operator would, offers the new type and filters on it.
        const [breadcrumb] = screen.getAllByRole('link', { name: 'Tickets' }).filter((link) => link.closest('p'));
        if (!breadcrumb) throw new Error('The config page has no breadcrumb link back to the list.');
        await user.click(breadcrumb);
        await user.click(await screen.findByRole('textbox', { name: 'Ticket type' }));
        await user.click(await screen.findByRole('option', { name: 'Impact Play Debrief' }));

        expect(await screen.findByText('Nothing matches that')).toBeTruthy();
        expect(dashboard.requests.map((request) => request.path)).toContain(
            `/api/guilds/${ticketGuild.guild.id}/tickets?status=open&type=impact-play`
        );
    });
});
