import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Guild, GuildBasedChannel, GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { Viewers } from '../../tools/visibleChannels';
import { linkReferences, unlinkReferences } from '../linkReferences';

const GUILD_ID = 'guild';

/** A server with channels (and who can view each), members and roles — what `linkReferences` reads. */
function fakeServer() {
    const guild = {
        id: GUILD_ID,
        channels: { cache: new Map<string, GuildBasedChannel>() },
        members: { cache: new Map<string, GuildMember>() },
        roles: { cache: new Map<string, { id: string; name: string }>() },
    };
    const channel = (id: string, name: string, viewers: readonly string[]) =>
        guild.channels.cache.set(id, {
            id,
            name,
            type: ChannelType.GuildText,
            position: 0,
            parent: null,
            isThread: () => false,
            permissionsFor: (who: { id: string }) => ({
                has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel && viewers.includes(who.id),
            }),
        } as unknown as GuildBasedChannel);
    const member = (id: string, displayName: string, username: string) => {
        const created = { id, guild, displayName, user: { username, bot: false } } as unknown as GuildMember;
        guild.members.cache.set(id, created);
        return created;
    };
    channel('c-general', 'general', ['vex', 'mod']);
    channel('c-general-nsfw', 'general-nsfw', ['vex', 'mod']);
    channel('c-staff', 'staff-notes', ['mod']);
    channel('c-fancy', '💬・lounge', ['vex', 'mod']);
    channel('c-games-1', 'games', ['vex', 'mod']);
    channel('c-games-2', 'games', ['vex', 'mod']);
    channel('300000000000000001', 'mod-lounge', ['mod']);
    channel('300000000000000002', 'rules', ['vex', 'mod']);
    const vex = member('vex', 'Vex', 'vex_irl');
    const mod = member('mod', 'Mara Jade', 'mara');
    member('twin-1', 'Sam', 'sam_one');
    member('twin-2', 'Sam', 'sam_two');
    guild.roles.cache.set(GUILD_ID, { id: GUILD_ID, name: '@everyone' });
    guild.roles.cache.set('r-verified', { id: 'r-verified', name: 'Verified' });
    return { vex, mod };
}

const { vex, mod } = fakeServer();
/** Vex asking in a channel the moderator also reads: both will see the answer. */
const VEX_AND_MOD: Viewers = [vex, mod];

describe('linkReferences', () => {
    it('turns a #name everyone can see into a channel link, at any punctuation', () => {
        expect(linkReferences('Go to #general. Or #GENERAL, or (#general)!', VEX_AND_MOD).text).toBe(
            'Go to <#c-general>. Or <#c-general>, or (<#c-general>)!'
        );
    });

    it('takes the longest name, so #general-nsfw is not #general', () => {
        expect(linkReferences('Spicy stuff: #general-nsfw', VEX_AND_MOD).text).toBe('Spicy stuff: <#c-general-nsfw>');
    });

    it('links names with emoji and separators in them', () => {
        expect(linkReferences('Hang out in #💬・lounge tonight', VEX_AND_MOD).text).toBe('Hang out in <#c-fancy> tonight');
    });

    it('leaves a channel some viewer cannot see, one that does not exist, and an ambiguous one as written', () => {
        expect(linkReferences('#staff-notes, #nsfw-chat, #games', VEX_AND_MOD).text).toBe('#staff-notes, #nsfw-chat, #games');
    });

    it('reports each #name that is no channel everyone sees — not an ambiguous one — and unmarks them when asked', () => {
        expect(linkReferences('#staff-notes, #nsfw-chat, #nsfw-chat, #games, rule #3', VEX_AND_MOD).unknownChannels).toEqual(['staff-notes', 'nsfw-chat']);
        expect(linkReferences('Try #nsfw-chat or #general', VEX_AND_MOD, 'unmark').text).toBe('Try nsfw-chat or <#c-general>');
    });

    it('does not treat a longer word as the shorter channel', () => {
        expect(linkReferences('#generalised anxiety', VEX_AND_MOD).text).toBe('#generalised anxiety');
    });

    it('turns @name into a member link, by display name (spaces included) or username', () => {
        expect(linkReferences('Ask @Mara Jade, or @vex_irl, or @vex.', VEX_AND_MOD).text).toBe('Ask <@mod>, or <@vex>, or <@vex>.');
    });

    it('turns @role into a role link', () => {
        expect(linkReferences('Only @Verified folks', VEX_AND_MOD).text).toBe('Only <@&r-verified> folks');
    });

    it('never links @everyone or @here, nor a name two members share', () => {
        expect(linkReferences('@everyone @here @Sam', VEX_AND_MOD).text).toBe('@everyone @here @Sam');
    });

    it('leaves names inside code alone, where Discord would show the raw id', () => {
        expect(linkReferences('Type `#general` or\n```\n@Vex in #general\n```\nthen #general', VEX_AND_MOD).text).toBe(
            'Type `#general` or\n```\n@Vex in #general\n```\nthen <#c-general>'
        );
    });

    it('leaves emails, paths, lone sigils, and markup naming something real alone', () => {
        expect(linkReferences('mail vex@vex_irl.com, site.com/#general, see <#c-general> and <@vex>, # general, @ Vex', VEX_AND_MOD).text).toBe(
            'mail vex@vex_irl.com, site.com/#general, see <#c-general> and <@vex>, # general, @ Vex'
        );
    });

    it('posts markup the model made up — or for a channel not everyone sees — as text', () => {
        expect(linkReferences('Try <#1234567890>, <#300000000000000001>, <@4242> or <@&999>', VEX_AND_MOD).text).toBe(
            'Try #unknown-channel, #unknown-channel, @someone or @someone'
        );
        expect(linkReferences('Read <#300000000000000002>', VEX_AND_MOD).text).toBe('Read <#300000000000000002>');
    });
});

describe('unlinkReferences', () => {
    it('turns links back into the names the model writes, leaving code as posted', () => {
        const guild = {
            channels: { cache: new Map([['1', { name: 'rules' }]]) },
            roles: { cache: new Map([['2', { name: 'Moderator' }]]) },
            members: { cache: new Map([['3', { displayName: 'Kat' }]]) },
        } as unknown as Guild;

        expect(unlinkReferences('Read <#1>, ask <@&2> or <@3> — not `<#1>`. <#9>?', guild)).toBe('Read #rules, ask @Moderator or @Kat — not `<#1>`. #unknown-channel?');
    });
});
