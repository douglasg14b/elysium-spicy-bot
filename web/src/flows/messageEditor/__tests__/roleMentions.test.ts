import { describe, expect, it } from 'vitest';
import type { GuildRole } from '@brattybot/web-sdk';
import { segmentsOf } from '../CopyText';
import { roleMentionLabel, roleMentionStyle, showsRoleMentions, UNKNOWN_ROLE_LABEL } from '../roleMentions';

const VERIFIED: GuildRole = { id: '222222222222222222', name: 'Verified', color: 0xe74c3c, position: 3, owner: null };
const PLAIN: GuildRole = { id: '333333333333333333', name: 'Kinkster', color: 0, position: 1, owner: null };

describe('segmentsOf', () => {
    it('cuts role mentions out beside tokens, in order, where the part shows them', () => {
        expect(segmentsOf('(Ping <@&222222222222222222> / {{subject.mention}})', true)).toEqual([
            { kind: 'text', text: '(Ping ' },
            { kind: 'role', text: '<@&222222222222222222>', roleId: '222222222222222222' },
            { kind: 'text', text: ' / ' },
            { kind: 'token', text: '{{subject.mention}}' },
            { kind: 'text', text: ')' },
        ]);
    });

    it('keeps two mentions side by side apart', () => {
        expect(segmentsOf('<@&1><@&2>', true)).toEqual([
            { kind: 'role', text: '<@&1>', roleId: '1' },
            { kind: 'role', text: '<@&2>', roleId: '2' },
        ]);
    });

    it('leaves `<@&id>` as written where the part does not show mentions', () => {
        expect(segmentsOf('Hi <@&222222222222222222>', false)).toEqual([{ kind: 'text', text: 'Hi <@&222222222222222222>' }]);
    });

    it('takes a mention built from a token as the token, not a role', () => {
        expect(segmentsOf('<@&{{var.roleId}}>', true)).toEqual([
            { kind: 'text', text: '<@&' },
            { kind: 'token', text: '{{var.roleId}}' },
            { kind: 'text', text: '>' },
        ]);
    });
});

describe('a mentioned role', () => {
    it('is named by the role, or as unknown when the list does not hold it', () => {
        expect(roleMentionLabel(VERIFIED.id, [VERIFIED])).toBe('@Verified');
        expect(roleMentionLabel('999', [VERIFIED])).toBe(UNKNOWN_ROLE_LABEL);
    });

    it("is drawn in the role's colour, or Discord's blurple for one with none", () => {
        expect(roleMentionStyle(VERIFIED.id, [VERIFIED, PLAIN])).toMatchObject({ color: '#e74c3c' });
        expect(roleMentionStyle(PLAIN.id, [VERIFIED, PLAIN])).toMatchObject({ color: '#c9cdfb' });
    });
});

describe('showsRoleMentions', () => {
    it('is the plain text, an embed body and a field text — where Discord draws the role', () => {
        expect(showsRoleMentions({ kind: 'content' })).toBe(true);
        expect(showsRoleMentions({ kind: 'description', embed: 0 })).toBe(true);
        expect(showsRoleMentions({ kind: 'fieldValue', embed: 0, field: 0 })).toBe(true);
        expect(showsRoleMentions({ kind: 'title', embed: 0 })).toBe(false);
        expect(showsRoleMentions({ kind: 'fieldName', embed: 0, field: 0 })).toBe(false);
        expect(showsRoleMentions({ kind: 'footerText', embed: 0 })).toBe(false);
        expect(showsRoleMentions({ kind: 'authorName', embed: 0 })).toBe(false);
    });
});
