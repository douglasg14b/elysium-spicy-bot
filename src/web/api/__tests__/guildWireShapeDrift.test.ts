import { describe, expect, it } from 'vitest';
import { GUILD_CHANNEL_KEYS, GUILD_CHANNEL_TYPES, GUILD_ROLE_KEYS } from '../guildBody';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between the guild directory shapes and the browser's copy of them.
 *
 * Same machinery as `ticketWireShapeDrift` and `driftWireShapeDrift`, and added here
 * because `GuildChannel` just went from two fields to five — one of which is a **closed
 * vocabulary** that every consumer branches on. A type the browser does not know about
 * is a channel silently treated as whatever the last `else` happens to be, and the
 * consequence is specific: a category offered as somewhere to post a message, which
 * fails in a live guild after publish.
 *
 * The vocabulary row is the one that earns its place. Comparing field *names* would not
 * have caught the repair-outcome incident these gates exist because of, and it would not
 * catch a fourth channel type added on one side here either.
 */

const REMEDY =
    'Reconcile the guild interfaces and their *_KEYS arrays in `web/src/api/types.ts` with ' +
    'the wire shapes in `src/web/api/guildBody.ts`. Both sides export member lists their own ' +
    'compiler holds to the interface, so the fix is to add the member in both places.';

const SHAPES = [
    {
        name: 'GuildChannel',
        server: GUILD_CHANNEL_KEYS,
        browser: browserTypes.GUILD_CHANNEL_KEYS,
    },
    { name: 'GuildRole', server: GUILD_ROLE_KEYS, browser: browserTypes.GUILD_ROLE_KEYS },
] as const satisfies readonly { name: string; server: readonly string[]; browser: readonly string[] }[];

describe('guild wire shape drift between server and browser', () => {
    it.each(SHAPES)('keeps $name identical on both sides', ({ name, server, browser }) => {
        const serverMembers = [...server].sort();
        const browserMembers = [...browser].sort();

        expect(
            browserMembers,
            `\`${name}\` has drifted. Server: [${serverMembers.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserMembers.join(', ')}]. A member the browser does ` +
                `not declare is one it is served and cannot read. ${REMEDY}`
        ).toEqual(serverMembers);
    });

    it('keeps the channel type vocabulary identical on both sides', () => {
        const serverTypes = [...GUILD_CHANNEL_TYPES].sort();
        const browserTypeNames = [...browserTypes.GUILD_CHANNEL_TYPES].sort();

        expect(
            browserTypeNames,
            `GUILD_CHANNEL_TYPES has drifted. Server: [${serverTypes.join(', ')}]; browser: ` +
                `[${browserTypeNames.join(', ')}]. This union is closed on both sides and is what ` +
                'every channel picker filters on, so a type the browser cannot name is one it ' +
                'cannot exclude — and the thing it most needs to exclude is a category, which ' +
                'is not somewhere a message can be sent.'
        ).toEqual(serverTypes);
    });
});
