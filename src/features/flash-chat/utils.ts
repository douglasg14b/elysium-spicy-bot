import { Message, TextChannel } from 'discord.js';

export async function deleteMessageSafely(message: Message): Promise<void> {
    // Check if message still exists before trying to delete
    const messageToDelete = await message.channel.messages
        .fetch({
            message: message.id,
            force: true,
        })
        .catch(() => null);

    if (!messageToDelete) return;

    try {
        await messageToDelete.delete();
        console.log(
            `🗑️ Deleted message ${message.id} from ${message.author.tag} in #${(message.channel as TextChannel).name}`
        );
    } catch (error) {
        console.error(`❌ Failed to delete message ${message.id}:`, (error as Error).message);
    }
}
