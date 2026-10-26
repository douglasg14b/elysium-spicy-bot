import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChannelType,
    Events,
    GuildMember,
    type Interaction,
    type TextChannel,
} from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TestDiscord, TestDiscordError, type ServerChannel, type ServerGuild, type ServerMember } from './support/testDiscord';

/**
 * TestDiscord's button presses, proven: the INTERACTION_CREATE it sends reaches discord.js as
 * a real `ButtonInteraction`, the two answers it models are kept on the press, and what it does
 * not model is refused rather than answered with a guess.
 */

const started: TestDiscord[] = [];

afterEach(async () => {
    for (const discord of started.splice(0)) await discord.destroy();
});

interface Pressable {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly channel: ServerChannel;
    readonly member: ServerMember;
    readonly messageId: string;
    /** Every interaction the client emitted, in order. */
    readonly heard: Interaction[];
}

/** A started client, a member, and a bot message in `#rules` carrying one `agree` button. */
async function pressable(): Promise<Pressable> {
    const discord = new TestDiscord();
    started.push(discord);
    const guild = discord.createGuild({ bot: { permissions: ['SendMessages'] } });
    const channel = guild.createTextChannel({ name: 'rules' });
    const member = guild.createMember({ username: 'button_masher' });
    const client = await discord.start();
    const heard: Interaction[] = [];
    client.on(Events.InteractionCreate, (interaction) => heard.push(interaction));

    const liveChannel = discord.clientGuild(guild).channels.cache.get(channel.id) as TextChannel;
    const sent = await liveChannel.send({
        content: 'Read these, then pick.',
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('agree').setLabel('I agree').setStyle(ButtonStyle.Success)
            ),
        ],
    });
    return { discord, guild, channel, member, messageId: sent.id, heard };
}

function onlyPress(heard: readonly Interaction[]): ButtonInteraction {
    const [interaction] = heard;
    if (heard.length !== 1 || !(interaction instanceof ButtonInteraction)) {
        throw new Error(`Expected one button press, heard ${heard.length}.`);
    }
    return interaction;
}

describe('TestDiscord sends button presses the way Discord does', () => {
    it('delivers a ButtonInteraction carrying the presser as a guild member and the message as Discord holds it', async () => {
        const { channel, member, messageId, heard } = await pressable();

        const press = channel.pressButton({ by: member, messageId, customId: 'agree' });

        const interaction = onlyPress(heard);
        expect(interaction.id).toBe(press.id);
        expect(interaction.customId).toBe('agree');
        expect(interaction.member).toBeInstanceOf(GuildMember);
        expect(interaction.user.id).toBe(member.id);
        expect(interaction.channel?.type).toBe(ChannelType.GuildText);
        expect(interaction.message.id).toBe(messageId);
        expect(interaction.message.content).toBe('Read these, then pick.');
        expect(press.responses).toEqual([]);
    });

    it('keeps a deferred update and an ephemeral reply on the press, and puts neither in the channel', async () => {
        const { channel, member, messageId, heard } = await pressable();

        const deferred = channel.pressButton({ by: member, messageId, customId: 'agree' });
        await onlyPress(heard).deferUpdate();
        heard.length = 0;
        const replied = channel.pressButton({ by: member, messageId, customId: 'agree' });
        await onlyPress(heard).reply({ content: 'Not for you, pet.', ephemeral: true });

        expect(deferred.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(replied.responses).toEqual([{ kind: 'ephemeralReply', content: 'Not for you, pet.' }]);
        expect(channel.messages.map((message) => message.id)).toEqual([messageId]);
    });
});

describe('TestDiscord refuses presses and answers it does not know', () => {
    it('refuses a press on a button the message does not hold', async () => {
        const { channel, member, messageId } = await pressable();

        expect(() => channel.pressButton({ by: member, messageId, customId: 'nope' })).toThrow(TestDiscordError);
    });

    it('refuses a press on a disabled button', async () => {
        const { discord, guild, channel, member } = await pressable();
        const liveChannel = discord.clientGuild(guild).channels.cache.get(channel.id) as TextChannel;
        const sent = await liveChannel.send({
            content: 'Too late, pet.',
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('closed').setLabel('Closed').setStyle(ButtonStyle.Secondary).setDisabled(true)
                ),
            ],
        });

        expect(() => channel.pressButton({ by: member, messageId: sent.id, customId: 'closed' })).toThrow(/is disabled/);
    });

    it('refuses a press in a channel whose overwrites touch the presser', async () => {
        const { guild, channel, member, messageId } = await pressable();
        channel.setOverwrite(guild.everyone, { deny: ['SendMessages'] });

        expect(() => channel.pressButton({ by: member, messageId, customId: 'agree' })).toThrow(/overwrite/);
    });

    it('faults on a second acknowledgement of one press, and on a public reply', async () => {
        const { discord, channel, member, messageId, heard } = await pressable();

        channel.pressButton({ by: member, messageId, customId: 'agree' });
        const interaction = onlyPress(heard);
        await interaction.deferUpdate();
        // discord.js would refuse a second answer itself; this goes round it to reach Discord.
        await expect(
            interaction.client.rest.post(`/interactions/${interaction.id}/${interaction.token}/callback`, {
                body: { type: 6 },
                auth: false,
                query: new URLSearchParams({ with_response: 'false' }),
            })
        ).rejects.toThrow(/acknowledged twice/);

        heard.length = 0;
        channel.pressButton({ by: member, messageId, customId: 'agree' });
        await expect(onlyPress(heard).reply({ content: 'Everyone look at this.' })).rejects.toThrow(/does not model this request body/);

        started.splice(started.indexOf(discord), 1);
        await expect(discord.destroy()).rejects.toThrow(/faulted 2 time/);
    });
});
