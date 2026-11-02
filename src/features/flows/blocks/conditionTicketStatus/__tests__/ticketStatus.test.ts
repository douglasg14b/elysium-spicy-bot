import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveRequirements } from '../../../engine/nodeRequirements';
import { parseNodeConfig, type BlockManifest } from '../../manifest';

/**
 * `condition.ticketStatus`: one exit per status, read from the record the run finds, and
 * No ticket — not a failure — when the choice names none in this server.
 */

const getTicket = vi.fn();
const getTicketByChannel = vi.fn();

vi.mock('../../../../tickets', () => ({
    getTicket,
    getTicketByChannel,
    TICKET_STATUSES: ['open', 'closed', 'deleted'],
    TICKET_VARIABLES: { ticketSubjectId: 'ticketSubjectId', ticketSubjectMention: 'ticketSubjectMention' },
}));

const { block } = await import('../index');

const registered: BlockManifest = block;

/** Run the block on raw node data, parsed exactly as the executor parses it. */
async function runOn(data: Record<string, unknown>, runContext: never) {
    const parsed = parseNodeConfig(registered, data);
    if (!parsed.success) throw new Error(`refused ${JSON.stringify(data)}: ${parsed.error.message}`);
    return registered.run(parsed.data, runContext);
}

const ticket = { id: 7, guildId: 'guild-1', status: 'open', channelId: 'channel-1', subjectId: '555' };

const setOutput = vi.fn();

function context(channelId: string | null = 'channel-1', parentId?: string) {
    return {
        guild: { id: 'guild-1' },
        setOutput,
        ...(channelId === null
            ? {}
            : { channel: { id: channelId, parentId: parentId ?? null, isThread: () => parentId !== undefined } }),
    } as never;
}

const byId = (ticketId: string) => ({ source: 'id' as const, ticketId });
const HERE = { source: 'here' as const };

beforeEach(() => {
    vi.clearAllMocks();
    getTicket.mockResolvedValue(ticket);
    getTicketByChannel.mockResolvedValue(ticket);
});

describe('condition.ticketStatus by id', () => {
    it.each(['open', 'closed', 'deleted'] as const)('leaves by %s for a ticket that is', async (status) => {
        getTicket.mockResolvedValue({ ...ticket, status });

        expect(await block.run(byId('7'), context())).toEqual({ kind: 'continue', handle: status });
        expect(getTicket).toHaveBeenCalledWith(7);
    });

    it('says No ticket for an id that names none', async () => {
        getTicket.mockResolvedValue(null);

        expect(await block.run(byId('999'), context())).toEqual({ kind: 'continue', handle: 'noTicket' });
    });

    it("says No ticket for another server's ticket, though the id exists", async () => {
        getTicket.mockResolvedValue({ ...ticket, guildId: 'guild-2' });

        expect(await block.run(byId('7'), context())).toEqual({ kind: 'continue', handle: 'noTicket' });
    });

    it('fails a token that rendered to nothing rather than answering for ticket 0', async () => {
        await expect(block.run(byId(''), context())).rejects.toThrow('Ticket Status? needs a ticket id');
        expect(getTicket).not.toHaveBeenCalled();
    });
});

describe('condition.ticketStatus on the ticket in this channel', () => {
    it("finds the ticket by the run's channel", async () => {
        getTicketByChannel.mockResolvedValue({ ...ticket, status: 'closed' });

        expect(await block.run(HERE, context('channel-1'))).toEqual({ kind: 'continue', handle: 'closed' });
        expect(getTicketByChannel).toHaveBeenCalledWith('channel-1');
        expect(getTicket).not.toHaveBeenCalled();
    });

    it('counts a thread toward the channel it sits under', async () => {
        await block.run(HERE, context('thread-1', 'channel-1'));

        expect(getTicketByChannel).toHaveBeenCalledWith('channel-1');
    });

    it("says No ticket in a channel that is no ticket's", async () => {
        getTicketByChannel.mockResolvedValue(null);

        expect(await block.run(HERE, context('general'))).toEqual({ kind: 'continue', handle: 'noTicket' });
    });

    it("says No ticket for another server's ticket on a matching channel id", async () => {
        getTicketByChannel.mockResolvedValue({ ...ticket, guildId: 'guild-2' });

        expect(await block.run(HERE, context('channel-1'))).toEqual({ kind: 'continue', handle: 'noTicket' });
    });

    it('fails by name when the run has no channel', async () => {
        await expect(block.run(HERE, context(null))).rejects.toThrow(
            "Ticket Status? is set to use the ticket in this channel, and this run isn't in a channel the bot can reach"
        );
    });

    it('ignores an id the node still holds from before the switch', async () => {
        await runOn({ source: 'here', ticketId: '999' }, context('channel-1'));

        expect(getTicketByChannel).toHaveBeenCalledWith('channel-1');
        expect(getTicket).not.toHaveBeenCalled();
    });
});

describe('condition.ticketStatus outputs', () => {
    it.each(['open', 'closed', 'deleted'] as const)(
        "records who the ticket is for on %s, not the run's own subject",
        async (status) => {
            getTicketByChannel.mockResolvedValue({ ...ticket, status });

            await block.run(HERE, context());

            expect(setOutput).toHaveBeenCalledWith('ticketSubjectId', '555');
            expect(setOutput).toHaveBeenCalledWith('ticketSubjectMention', '<@555>');
        }
    );

    it('writes nothing on No ticket', async () => {
        getTicketByChannel.mockResolvedValue(null);

        await block.run(HERE, context('general'));

        expect(setOutput).not.toHaveBeenCalled();
    });

    it('declares both names on every exit that finds a ticket, and none on No ticket', () => {
        const declared = (block.outputs ?? []).map((output) => ({
            key: 'key' in output ? output.key : undefined,
            handle: output.handle,
        }));

        for (const handle of ['open', 'closed', 'deleted']) {
            expect(declared).toContainEqual({ key: 'ticketSubjectId', handle });
            expect(declared).toContainEqual({ key: 'ticketSubjectMention', handle });
        }
        expect(declared.some(({ handle }) => handle === 'noTicket')).toBe(false);
    });
});

describe('condition.ticketStatus config', () => {
    it('asks for an id only while looking one up by id', () => {
        const without = parseNodeConfig(registered, {});
        expect(without.error?.issues).toEqual([expect.objectContaining({ path: ['ticketId'] })]);

        expect(parseNodeConfig(registered, { source: 'here' }).success).toBe(true);
    });

    it("needs the run's channel only for the ticket in this channel", () => {
        const needs = (data: Record<string, unknown>) => effectiveRequirements(block, data).map(({ requirement }) => requirement);

        expect(needs({ ticketId: '{{var.ticketId}}' })).toEqual([]);
        expect(needs({ source: 'here' })).toEqual(['channel']);
    });
});
