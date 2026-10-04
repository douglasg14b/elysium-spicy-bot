import { describe, expect, it } from 'vitest';
import { zCreateFlowBody, zUpdateWarningsConfigBody } from '../index';

/**
 * What a page sees: checking a form against the SDK's zod gives the server's own sentence
 * as the issue's message, the one the server would refuse the request with.
 */

describe('request messages, as a page reads them', () => {
    it('refuses an empty warnings channel with the server’s sentence', () => {
        const result = zUpdateWarningsConfigBody.safeParse({ modChannelId: '' });

        expect(result.success).toBe(false);
        expect(result.error?.issues.map((issue) => issue.message)).toEqual([
            'Pick a channel. Warning notices do not haunt the void.',
        ]);
    });

    it('refuses a flow name at both of its bounds with the server’s sentences', () => {
        const empty = zCreateFlowBody.safeParse({ name: '' });
        const long = zCreateFlowBody.safeParse({ name: 'x'.repeat(101) });

        expect(empty.error?.issues.map((issue) => issue.message)).toEqual(['Give the flow a name.']);
        expect(long.error?.issues.map((issue) => issue.message)).toEqual(['Flow names cap at 100 characters.']);
    });
});
