import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfiguredTicketingConfig, TicketTypeDefinition } from '../../data/ticketingSchema';
import type { TicketEntity } from '../../data/ticketsSchema';

/**
 * The one orchestration every lifecycle caller goes through.
 *
 * The service and the channel ops are both mocked, because what is under test here is
 * the *sequence* — commit, sync, re-render, announce — and specifically what happens
 * when one step fails. Whether `closeTicket` refuses a deleted ticket is settled in
 * `ticketService.test.ts`; asserting it again through this function would test the
 * service twice and the ordering not at all.
 *
 * The ordering assertion is the load-bearing one. A version of this that committed
 * *after* syncing would pass every individual-step test and still be wrong in the way
 * that matters: a Discord failure would leave the channel moved for a transition the
 * row never recorded.
 */

const serviceMock = {
    claimTicket: vi.fn(),
    unclaimTicket: vi.fn(),
    closeTicket: vi.fn(),
    reopenTicket: vi.fn(),
};

const syncTicketChannelToState = vi.fn();

vi.mock('../../ticketService', () => serviceMock);
vi.mock('../ticketChannelOps', () => ({ syncTicketChannelToState }));

const { applyTicketTransition } = await import('../applyTicketTransition');

const CHANNEL_ID = 'channel-1';
const STATE_MESSAGE_ID = 'message-1';
const ACTOR_ID = 'actor-1';

const definition: TicketTypeDefinition = {
    type: 'support',
    label: 'Support',
    nameTemplate: 'S{{####}}-{{subject}}',
    permissions: {
        subject: { view: true, send: true, readHistory: true, manageMessages: false },
        opener: { view: true, send: true, readHistory: true, manageMessages: false },
        staff: { view: true, send: true, readHistory: true, manageMessages: true },
    },
    autoClaimOnOpen: true,
};

const config: ConfiguredTicketingConfig = {
    modTicketsDeployed: true,
    modTicketsDeployedChannelId: 'panel-channel',
    modTicketsDeployedMessageId: 'panel-message',
    supportTicketCategoryName: 'Tickets',
    claimedTicketCategoryName: 'Claimed',
    closedTicketCategoryName: 'Closed',
    moderationRoles: ['mod-role'],
    ticketTypes: { support: definition },
};

function ticketStub(overrides: Partial<TicketEntity> = {}): TicketEntity {
    return {
        id: 7,
        guildId: 'guild-1',
        ticketNumber: 42,
        type: 'support',
        status: 'open',
        subjectId: 'subject-1',
        openerId: 'opener-1',
        claimerId: null,
        channelId: CHANNEL_ID,
        subjectUsername: 'subject',
        subjectNickname: null,
        openerUsername: 'opener',
        openerNickname: null,
        claimerUsername: null,
        claimerNickname: null,
        stateMessageId: STATE_MESSAGE_ID,
        title: 'A title',
        reason: 'A reason',
        openedAt: new Date('2026-09-01T00:00:00.000Z'),
        claimedAt: null,
        closedAt: null,
        deletedAt: null,
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        ...overrides,
    } as TicketEntity;
}

/**
 * A guild whose channel fetch yields a text channel recording what it was told.
 *
 * `calls` is shared with the message edit and the service call so the ordering test
 * can read one sequence rather than compare three mock timestamps.
 */
function harness(options: { channel?: boolean; fetchedMessage?: boolean } = {}) {
    const calls: string[] = [];
    const sent: string[] = [];

    const fetchedMessage = {
        edit: vi.fn(async () => {
            calls.push('render');
        }),
    };

    const channel = {
        type: 0, // ChannelType.GuildText
        id: CHANNEL_ID,
        send: vi.fn(async (content: string) => {
            calls.push('announce');
            sent.push(content);
        }),
        messages: {
            fetch: vi.fn(async () => (options.fetchedMessage === false ? null : fetchedMessage)),
        },
    };

    const guild = {
        id: 'guild-1',
        channels: { fetch: vi.fn(async () => (options.channel === false ? null : channel)) },
    };

    return { calls, sent, guild, channel, fetchedMessage };
}

beforeEach(() => {
    vi.clearAllMocks();
    syncTicketChannelToState.mockResolvedValue({ ok: true });
});

describe('applyTicketTransition', () => {
    it('commits the row, syncs the channel, edits the message and announces, in that order', async () => {
        const { calls, guild, fetchedMessage } = harness();
        const committed = ticketStub({ claimerId: ACTOR_ID });

        serviceMock.claimTicket.mockImplementation(async () => {
            calls.push('commit');
            return { ok: true, value: committed };
        });
        syncTicketChannelToState.mockImplementation(async () => {
            calls.push('sync');
            return { ok: true };
        });

        const result = await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub(),
            definition,
            transition: 'claim',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: { username: 'mod', nickname: 'Mod' } },
        });

        expect(result.ok).toBe(true);
        expect(calls).toEqual(['commit', 'sync', 'render', 'announce']);
        expect(fetchedMessage.edit).toHaveBeenCalledOnce();
    });

    it('returns the service message and touches Discord not at all when the transition is refused', async () => {
        const { guild, channel } = harness();
        serviceMock.closeTicket.mockResolvedValue({ ok: false, error: 'Ticket #42 is already closed.' });

        const result = await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub(),
            definition,
            transition: 'close',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: null },
        });

        expect(result).toEqual({ ok: false, message: 'Ticket #42 is already closed.' });
        // The whole point of committing first: a refusal must not move a channel or
        // announce a close that did not happen.
        expect(syncTicketChannelToState).not.toHaveBeenCalled();
        expect(channel.send).not.toHaveBeenCalled();
        expect(guild.channels.fetch).not.toHaveBeenCalled();
    });

    it('returns syncWarning — not a failure — when the row committed and the sync did not', async () => {
        const { guild, channel } = harness();
        serviceMock.reopenTicket.mockResolvedValue({ ok: true, value: ticketStub({ status: 'open' }) });
        syncTicketChannelToState.mockResolvedValue({ ok: false, error: new Error('missing perms') });

        const result = await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub({ status: 'closed' }),
            definition,
            transition: 'reopen',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: null },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The actual sentence, not merely "something truthy" — the reopen warning has to
        // say the subject may still be locked out, or it is not doing its job.
        expect(result.outcome.syncWarning).toContain('locked out');
        // Committed, so the rest of the sequence still runs: the operator is warned,
        // not left with a ticket that looks untouched.
        expect(channel.send).toHaveBeenCalledOnce();
    });

    it('warns on a failed close sync that the subject may still be able to read the channel', async () => {
        const { guild } = harness();
        serviceMock.closeTicket.mockResolvedValue({ ok: true, value: ticketStub({ status: 'closed' }) });
        syncTicketChannelToState.mockResolvedValue({ ok: false, error: new Error('missing perms') });

        const result = await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub(),
            definition,
            transition: 'close',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: null },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The one warning that is a security statement rather than an inconvenience.
        // A generic "could not update the channel" would bury it.
        expect(result.outcome.syncWarning).toContain('still be able to read this channel');
    });

    it('fetches the state message by stateMessageId when no message is supplied', async () => {
        const { guild, channel, fetchedMessage } = harness();
        serviceMock.closeTicket.mockResolvedValue({ ok: true, value: ticketStub({ status: 'closed' }) });

        await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub(),
            definition,
            transition: 'close',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: null },
        });

        // This is the whole reason `stateMessageId` exists: a web caller has no
        // `interaction.message`, and without this the in-channel embed would keep
        // advertising a state the row no longer holds.
        expect(channel.messages.fetch).toHaveBeenCalledWith(STATE_MESSAGE_ID);
        expect(fetchedMessage.edit).toHaveBeenCalledOnce();
    });

    it('edits the supplied message instead of fetching one', async () => {
        const { guild, channel } = harness();
        const supplied = { edit: vi.fn(async () => undefined) };
        serviceMock.closeTicket.mockResolvedValue({ ok: true, value: ticketStub({ status: 'closed' }) });

        await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub(),
            definition,
            transition: 'close',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: null },
            message: supplied as never,
        });

        expect(supplied.edit).toHaveBeenCalledOnce();
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    it('commits and reports no warning for a ticket with no channel', async () => {
        const { guild } = harness();
        serviceMock.closeTicket.mockResolvedValue({
            ok: true,
            value: ticketStub({ status: 'closed', channelId: null }),
        });

        const result = await applyTicketTransition({
            guild: guild as never,
            config,
            // A ticket whose channel was deleted is still a ticket. Closing one is not
            // a failure and must not warn about a channel that does not exist.
            ticket: ticketStub({ channelId: null }),
            definition,
            transition: 'close',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: null },
        });

        // The committed row itself, not `expect.anything()`: this is what a caller renders
        // from, and a placeholder here would pass even if the wrong ticket came back.
        expect(result).toEqual({
            ok: true,
            outcome: { ticket: ticketStub({ status: 'closed', channelId: null }), syncWarning: null },
        });
        expect(syncTicketChannelToState).not.toHaveBeenCalled();
    });

    it('passes the actor identity into the claim so the names land in the guarded UPDATE', async () => {
        const { guild } = harness();
        serviceMock.claimTicket.mockResolvedValue({ ok: true, value: ticketStub({ claimerId: ACTOR_ID }) });

        await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub(),
            definition,
            transition: 'claim',
            actor: { id: ACTOR_ID, mention: '<@actor-1>', identity: { username: 'mod', nickname: 'Mod' } },
        });

        expect(serviceMock.claimTicket).toHaveBeenCalledWith(7, ACTOR_ID, {
            username: 'mod',
            nickname: 'Mod',
        });
    });

    it('announces with the actor mention the caller supplied, not a raw id', async () => {
        const { guild, sent } = harness();
        serviceMock.unclaimTicket.mockResolvedValue({ ok: true, value: ticketStub() });

        await applyTicketTransition({
            guild: guild as never,
            config,
            ticket: ticketStub({ claimerId: ACTOR_ID }),
            definition,
            transition: 'unclaim',
            // A web caller has no member to mention, so it sends readable text. A raw
            // `<@id>` from the dashboard would ping somebody on every browser click.
            actor: { id: ACTOR_ID, mention: 'Kitten (via the dashboard)', identity: null },
        });

        expect(sent[0]).toContain('Kitten (via the dashboard)');
    });
});
