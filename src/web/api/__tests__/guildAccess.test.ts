import { PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../auth/session';

/**
 * Who reaches which guild through the dashboard: owners and Administrators of servers the
 * bot is in, and — when `ALLOWED_GUILD_IDS` is set — only servers on that list, for
 * superusers too.
 *
 * The bot's view of each guild is a small stand-in: its owner, and each member's
 * permission check.
 */

const LISTED_GUILD_ID = '900000000000000001';
const UNLISTED_GUILD_ID = '900000000000000002';
const OWNER_ID = '200000000000000001';
const ADMIN_ID = '200000000000000002';
const MANAGER_ID = '200000000000000003';
const SUPERUSER_ID = '200000000000000009';

/** A member who holds exactly the permission bits named. */
function memberWith(bits: readonly bigint[]) {
    return { permissions: { has: (bit: bigint) => bits.includes(bit) } };
}

const MEMBERS: Readonly<Record<string, ReturnType<typeof memberWith>>> = {
    [ADMIN_ID]: memberWith([PermissionFlagsBits.Administrator]),
    [MANAGER_ID]: memberWith([PermissionFlagsBits.ManageGuild]),
};

/** A guild the bot is in, owned by {@link OWNER_ID}, who holds no Administrator bit. */
function fakeGuild(id: string) {
    return {
        id,
        ownerId: OWNER_ID,
        members: {
            fetch: async (userId: string) => {
                const member = MEMBERS[userId];
                if (!member) throw new Error('Unknown Member');
                return member;
            },
        },
    };
}

const allowlist = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock('../../../environment', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../environment')>();
    return {
        ...original,
        ADMIN_DISCORD_IDS: [SUPERUSER_ID],
        get ALLOWED_GUILD_IDS() {
            return allowlist.ids;
        },
    };
});

vi.mock('../../../discordClient', () => ({
    DISCORD_CLIENT: {
        guilds: { cache: new Map([LISTED_GUILD_ID, UNLISTED_GUILD_ID].map((id) => [id, fakeGuild(id)])) },
    },
}));

const { accessibleGuilds, hasManageableBotGuild, mayAccessGuild } = await import('../guildAccess');

function sessionFor(id: string): SessionUser {
    return { id, username: 'someone', avatar: null, manageableGuildIds: [LISTED_GUILD_ID, UNLISTED_GUILD_ID] };
}

beforeEach(() => {
    allowlist.ids = [];
});

describe('who may use the dashboard on a guild', () => {
    it('lets the owner in, though they hold no Administrator bit', async () => {
        expect(await mayAccessGuild(sessionFor(OWNER_ID), LISTED_GUILD_ID)).toBe(true);
    });

    it('lets an Administrator in', async () => {
        expect(await mayAccessGuild(sessionFor(ADMIN_ID), LISTED_GUILD_ID)).toBe(true);
    });

    it('turns away Manage Server without Administrator, whatever the session claims', async () => {
        expect(await mayAccessGuild(sessionFor(MANAGER_ID), LISTED_GUILD_ID)).toBe(false);
    });
});

describe('ALLOWED_GUILD_IDS', () => {
    it('allows every guild when unset', async () => {
        expect(await mayAccessGuild(sessionFor(ADMIN_ID), UNLISTED_GUILD_ID)).toBe(true);
        expect(accessibleGuilds(sessionFor(ADMIN_ID)).map((guild) => guild.id)).toEqual([LISTED_GUILD_ID, UNLISTED_GUILD_ID]);
    });

    it('treats an unlisted guild as not there, for an Administrator of it', async () => {
        allowlist.ids = [LISTED_GUILD_ID];

        expect(await mayAccessGuild(sessionFor(ADMIN_ID), UNLISTED_GUILD_ID)).toBe(false);
        expect(await mayAccessGuild(sessionFor(ADMIN_ID), LISTED_GUILD_ID)).toBe(true);
        expect(accessibleGuilds(sessionFor(ADMIN_ID)).map((guild) => guild.id)).toEqual([LISTED_GUILD_ID]);
    });

    it('bounds superusers too', async () => {
        allowlist.ids = [LISTED_GUILD_ID];

        expect(await mayAccessGuild(sessionFor(SUPERUSER_ID), UNLISTED_GUILD_ID)).toBe(false);
        expect(accessibleGuilds(sessionFor(SUPERUSER_ID)).map((guild) => guild.id)).toEqual([LISTED_GUILD_ID]);
    });

    it('refuses sign-in to someone whose only server is unlisted', () => {
        allowlist.ids = [LISTED_GUILD_ID];

        expect(hasManageableBotGuild([UNLISTED_GUILD_ID])).toBe(false);
        expect(hasManageableBotGuild([UNLISTED_GUILD_ID, LISTED_GUILD_ID])).toBe(true);
    });
});
