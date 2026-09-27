import type { PreviewPage, SeedContext } from './seedScenario';

/** Staff roles and the warnings mod channel: the settings every other area leans on. */
export async function seedSettings({ guild, api }: SeedContext): Promise<PreviewPage[]> {
    const guildPath = `/api/guilds/${guild.guild.id}`;

    await api.send('PUT', `${guildPath}/settings`, {
        staffRoleIds: [guild.roles.staff.id, guild.roles.moderators.id],
    });
    await api.send('PUT', `${guildPath}/config/warnings`, { modChannelId: guild.channels.modLog.id });

    return [
        { name: 'settings', path: '/settings', note: 'two staff roles picked out of eighteen, several with long names' },
        { name: 'warnings', path: '/warnings', note: 'mod channel configured' },
        { name: 'overview', path: '/overview', note: 'coming-soon placeholder' },
    ];
}
