import { describe, expect, it } from 'vitest';
import { GUILD_CHANNEL_TYPES, GuildChannelSchema, GuildRoleSchema } from '../guildBody';
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
 *
 * The server side is now the zod schema the route declares as its response, so its
 * member list is read off the schema. The browser side stays a hand mirror until the
 * pages still on `getGuildChannels` / `getGuildRoles` move to the generated SDK, whose
 * types come from the same schema; this gate retires with that mirror.
 */

const REMEDY =
    'Reconcile the guild interfaces and their *_KEYS arrays in `web/src/api/types.ts` with ' +
    'the response schemas in `src/web/api/guildBody.ts`: add the member on the side that lacks it.';

const SHAPES = [
    {
        name: 'GuildChannel',
        server: Object.keys(GuildChannelSchema.shape),
        browser: browserTypes.GUILD_CHANNEL_KEYS,
    },
    { name: 'GuildRole', server: Object.keys(GuildRoleSchema.shape), browser: browserTypes.GUILD_ROLE_KEYS },
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
