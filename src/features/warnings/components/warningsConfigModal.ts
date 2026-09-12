import {
    ChannelType,
    LabelBuilder,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    ModalSubmitInteraction,
    PermissionsBitField,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { setWarningsModChannel } from '../logic/setWarningsModChannel';

export const WARNINGS_CONFIG_MODAL_ID = 'warnings_config_modal';
export const WARNINGS_CONFIG_CHANNEL_INPUT_ID = 'warnings_config_channel_input';

export function WarningsConfigModalComponent() {
    function buildComponent(defaultChannelId?: string): ModalBuilder {
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(WARNINGS_CONFIG_CHANNEL_INPUT_ID)
            .setPlaceholder('Channel for warning issue notices')
            .setMinValues(1)
            .setMaxValues(1)
            .addChannelTypes(ChannelType.GuildText);

        if (defaultChannelId) {
            channelSelect.addDefaultChannels(defaultChannelId);
        }

        const channelLabel = new LabelBuilder()
            .setLabel('Mod channel')
            .setChannelSelectMenuComponent(channelSelect);

        return new ModalBuilder()
            .setCustomId(WARNINGS_CONFIG_MODAL_ID)
            .setTitle('Configure Warning Notices')
            .addLabelComponents(channelLabel);
    }

    async function handler(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
            return commandError('This command can only be used in a server.');
        }

        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
            return commandError('You need Manage Server to pick where warning notices go.');
        }

        const selectedChannel = interaction.fields
            .getSelectedChannels(WARNINGS_CONFIG_CHANNEL_INPUT_ID, false, [ChannelType.GuildText])
            ?.first();

        if (!selectedChannel) {
            return commandError('Pick a text channel. Warning notices do not haunt the void.');
        }

        await interaction.deferReply({ ephemeral: true });

        const result = await setWarningsModChannel(interaction.guildId, selectedChannel.id, {
            getGuild: async () => interaction.guild,
        });

        if (!result.ok) {
            await interaction.editReply({ content: result.message });
            return commandError(result.message);
        }

        await interaction.editReply({
            content: `Warning notices will now land in <#${result.config.modChannelId}>.`,
        });

        return commandSuccess();
    }

    return {
        handler,
        component: buildComponent(),
        buildComponent,
        interactionId: WARNINGS_CONFIG_MODAL_ID,
    };
}
