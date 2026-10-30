import type { PreviewPage, SeedContext } from './seedScenario';

/**
 * Two self-destructing channels, through the same PUT the page sends: one with a short timer
 * keeping what was there, one with a long timer that wiped it and deletes pins too.
 */
export async function seedFlashChat({ guild, api }: SeedContext): Promise<PreviewPage[]> {
    const guildPath = `/api/guilds/${guild.guild.id}`;

    await api.send('PUT', `${guildPath}/flash-chat/${guild.channels.general.id}`, {
        timeoutSeconds: 300,
        preservePinned: true,
        preserveHistory: true,
    });
    await api.send('PUT', `${guildPath}/flash-chat/${guild.channels.introductions.id}`, {
        timeoutSeconds: 86_400 + 5_400,
        preservePinned: false,
        preserveHistory: false,
    });

    return [
        { name: 'flash-chat', path: '/flash-chat', note: 'two channels, one keeping history and pins, one wiping both' },
        {
            name: 'flash-chat-add',
            path: '/flash-chat',
            note: 'the add dialog, its channel picker open',
            steps: [{ clickButton: 'Add channel' }, { clickTextbox: 'Channel' }],
        },
    ];
}
