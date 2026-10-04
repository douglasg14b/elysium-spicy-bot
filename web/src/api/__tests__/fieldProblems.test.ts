import { zSaveTicketTypeBody, zSaveTicketTypePath } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { fieldProblems } from '../fieldProblems';

/** The ticket type editor's check, as the page makes it: the SDK's zod, field by field. */

const PERMISSIONS = {
    subject: { view: true, send: true, readHistory: true, manageMessages: false },
    opener: { view: true, send: true, readHistory: true, manageMessages: false },
    staff: { view: true, send: true, readHistory: true, manageMessages: true },
};

describe('fieldProblems', () => {
    it('is empty when nothing is refused', () => {
        expect(fieldProblems(zSaveTicketTypePath.safeParse({ guildId: 'g', type: 'appeals' }))).toEqual({});
    });

    it('keeps the first refusal of each field, in the server’s words', () => {
        const problems = fieldProblems(
            zSaveTicketTypeBody.safeParse({
                label: '',
                // Empty, so the template trips its first rule and its pattern does not get a say.
                nameTemplate: '',
                permissions: PERMISSIONS,
                autoClaimOnOpen: false,
            })
        );

        expect(problems).toEqual({
            label: 'Give the type a label — operators have to pick it out of a list.',
            nameTemplate: 'A channel-name template cannot be empty. Discord insists on calling channels something.',
        });
    });

    it('names a bad key with the server’s sentence', () => {
        expect(fieldProblems(zSaveTicketTypePath.safeParse({ guildId: 'g', type: 'Appeals & Bans' }))).toEqual({
            type: 'That will not do as a key — lowercase letters, digits, `-` and `_` only. The label is where you get to be expressive.',
        });
    });

    it('keys a refusal with no field under the empty name, so it still counts', () => {
        expect(fieldProblems({ success: false, error: { issues: [{ path: [], message: 'Not an object.' }] } })).toEqual({
            '': 'Not an object.',
        });
    });
});
