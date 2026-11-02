import { beforeEach, describe, expect, it, vi } from 'vitest';

/** `condition.hasOpenTicket` hands on the ticket it found, including who it is for. */

const findOpenTicket = vi.fn();

vi.mock('../../../../tickets', () => ({
    findOpenTicket,
    TICKET_VARIABLES: {
        ticketId: 'ticketId',
        ticketChannelId: 'ticketChannelId',
        ticketSubjectId: 'ticketSubjectId',
        ticketSubjectMention: 'ticketSubjectMention',
    },
}));

const { block } = await import('../index');

const setOutput = vi.fn();
const context = { guild: { id: 'guild-1' }, subject: { id: '555' }, setOutput } as never;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('condition.hasOpenTicket outputs', () => {
    it('records the member it asked about as who the ticket is for, with a ready mention', async () => {
        findOpenTicket.mockResolvedValue({ id: 7, channelId: 'channel-1' });

        const outcome = await block.run({ ticketType: 'support', member: 'subject' }, context);

        expect(outcome).toEqual({ kind: 'continue', handle: 'true' });
        expect(setOutput).toHaveBeenCalledWith('ticketSubjectId', '555');
        expect(setOutput).toHaveBeenCalledWith('ticketSubjectMention', '<@555>');
    });

    it('writes nothing on No', async () => {
        findOpenTicket.mockResolvedValue(null);

        expect(await block.run({ ticketType: 'support', member: 'subject' }, context)).toEqual({
            kind: 'continue',
            handle: 'false',
        });
        expect(setOutput).not.toHaveBeenCalled();
    });
});
