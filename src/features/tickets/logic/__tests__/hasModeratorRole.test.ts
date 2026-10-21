import type { Guild, GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isUsableModerationRole, memberHasModeratorRole } from '../hasModeratorRole';

/**
 * A config saved before `@everyone` was refused as a moderation role can still hold the guild
 * id. These pin that it grants nothing where the list is used, not only where it is saved.
 */

const GUILD_ID = '100000000000000000';
const MOD_ROLE = '111111111111111111';

const guild = {
    id: GUILD_ID,
    roles: { cache: new Map([[GUILD_ID, { id: GUILD_ID }], [MOD_ROLE, { id: MOD_ROLE }]]) },
} as unknown as Guild;

/** A member holding only `@everyone`, as every member does. */
function plainMember(): GuildMember {
    return { guild, roles: { cache: new Map([[GUILD_ID, { id: GUILD_ID }]]) } } as unknown as GuildMember;
}

describe('a stored @everyone moderation role', () => {
    it('does not make every member a moderator', () => {
        expect(memberHasModeratorRole(plainMember(), [GUILD_ID])).toBe(false);
    });

    it('is not given a staff overwrite', () => {
        expect(isUsableModerationRole(guild, GUILD_ID)).toBe(false);
        expect(isUsableModerationRole(guild, MOD_ROLE)).toBe(true);
        expect(isUsableModerationRole(guild, '999999999999999999')).toBe(false);
    });
});
