import { describe, expect, it } from 'vitest';
import type { GuildChannel, GuildRole } from '@brattybot/web-sdk';
import { showsMentions } from '../messageDraft';
import {
    channelMentionLabel,
    mentionListsOf,
    roleMentionLabel,
    roleMentionStyle,
    segmentsOf,
    UNKNOWN_CHANNEL_LABEL,
    UNKNOWN_ROLE_LABEL,
} from '../mentions';

const VERIFIED: GuildRole = { id: '222222222222222222', name: 'Verified', color: 0xe74c3c, position: 3, owner: null };
const PLAIN: GuildRole = { id: '333333333333333333', name: 'Kinkster', color: 0, position: 1, owner: null };
const GENERAL: GuildChannel = {
    id: '666666666666666666',
    name: 'general',
    type: 'text',
    parentId: '888888888888888888',
    parentName: 'Lounge',
    owner: null,
};
const LOUNGE: GuildChannel = { id: '888888888888888888', name: 'Lounge', type: 'category', parentId: null, parentName: null, owner: null };

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

    it('cuts channel mentions out beside role mentions and tokens', () => {
        expect(segmentsOf('Head to <#666666666666666666>, <@&2> — {{subject.mention}}', true)).toEqual([
            { kind: 'text', text: 'Head to ' },
            { kind: 'channel', text: '<#666666666666666666>', channelId: '666666666666666666' },
            { kind: 'text', text: ', ' },
            { kind: 'role', text: '<@&2>', roleId: '2' },
            { kind: 'text', text: ' — ' },
            { kind: 'token', text: '{{subject.mention}}' },
        ]);
    });

    it('keeps two mentions side by side apart', () => {
        expect(segmentsOf('<@&1><@&2><#3>', true)).toEqual([
            { kind: 'role', text: '<@&1>', roleId: '1' },
            { kind: 'role', text: '<@&2>', roleId: '2' },
            { kind: 'channel', text: '<#3>', channelId: '3' },
        ]);
    });

    it('leaves `<@&id>` and `<#id>` as written where the part does not show mentions', () => {
        expect(segmentsOf('Hi <@&222222222222222222> in <#666666666666666666>', false)).toEqual([
            { kind: 'text', text: 'Hi <@&222222222222222222> in <#666666666666666666>' },
        ]);
    });

    it('takes a mention built from a token as the token, not a role', () => {
        expect(segmentsOf('<@&{{var.roleId}}>', true)).toEqual([
            { kind: 'text', text: '<@&' },
            { kind: 'token', text: '{{var.roleId}}' },
            { kind: 'text', text: '>' },
        ]);
    });

    it('takes a channel link built from a token as the token, not a channel', () => {
        expect(segmentsOf('Your room: <#{{var.ticketChannelId}}>', true)).toEqual([
            { kind: 'text', text: 'Your room: <#' },
            { kind: 'token', text: '{{var.ticketChannelId}}' },
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

describe('a mentioned channel', () => {
    it('is named by the channel, or as unknown when the list does not hold it', () => {
        expect(channelMentionLabel(GENERAL.id, [GENERAL])).toBe('#general');
        expect(channelMentionLabel('999', [GENERAL])).toBe(UNKNOWN_CHANNEL_LABEL);
        expect(UNKNOWN_CHANNEL_LABEL).toBe('#unknown-channel');
    });

    it('is offered only among text channels — a category is somewhere nobody posts', () => {
        const { channels } = mentionListsOf([], undefined, [LOUNGE, GENERAL]);
        expect(channels.map((channel) => channel.id)).toEqual([GENERAL.id]);
    });
});

describe('showsMentions', () => {
    it('is the plain text, an embed body and a field text — where Discord draws a mention by name', () => {
        expect(showsMentions({ kind: 'content' })).toBe(true);
        expect(showsMentions({ kind: 'description', embed: 0 })).toBe(true);
        expect(showsMentions({ kind: 'fieldValue', embed: 0, field: 0 })).toBe(true);
        expect(showsMentions({ kind: 'title', embed: 0 })).toBe(false);
        expect(showsMentions({ kind: 'fieldName', embed: 0, field: 0 })).toBe(false);
        expect(showsMentions({ kind: 'footerText', embed: 0 })).toBe(false);
        expect(showsMentions({ kind: 'authorName', embed: 0 })).toBe(false);
    });
});
