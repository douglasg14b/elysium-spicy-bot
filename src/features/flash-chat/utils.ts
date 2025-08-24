import { Message, TextChannel } from 'discord.js';

export async function deleteMessageSafely(message: Message): Promise<void> {
    // Check if message still exists before trying to delete
    const messageToDelete = await message.channel.messages.fetch(message.id).catch(() => null);

    if (!messageToDelete) return;

    await messageToDelete.delete();
    console.log(`🗑️ Deleted message from ${message.author.tag} in #${(message.channel as TextChannel).name}`);
}
