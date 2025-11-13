import { Guild } from 'discord.js';

export async function roleIdToName(guild: Guild, roleId: string): Promise<string | null> {
    try {
        const role = await guild.roles.fetch(roleId);
        return role ? role.name : null;
    } catch (error) {
        console.warn(`Failed to fetch role with ID ${roleId}:`, error);
        return null;
    }
}

export async function roleIdsToNames(guild: Guild, roleIds: string[]): Promise<string[]> {
    return Promise.all(
        roleIds.map(async (roleId) => {
            const roleName = await roleIdToName(guild, roleId);
            return roleName || 'Unknown Role';
        })
    );
}
