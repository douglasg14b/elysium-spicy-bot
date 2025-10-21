import {
    Channel,
    ChannelType,
    ChatInputCommandInteraction,
    PermissionsBitField,
    SlashCommandBuilder,
    TextChannel,
    User,
} from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKETS_COMMAND = 'tickets';

type SubCommand = 'add-user' | 'create';
type CommandArgs =
    | {
          subcommand: 'add-user';
          user: User;
          reason?: string;
      }
    | {
          subcommand: 'create';
          user: User;
          title: string;
      }
    | {
          subcommand: 'deploy';
          channel: Channel;
      };

export const ticketsCommand = new SlashCommandBuilder()
    .setName(TICKETS_COMMAND)
    .addSubcommand((sub) =>
        sub
            .setName('add-user')
            .setDescription('Add a user to the ticket')
            .addUserOption((opt) => opt.setName('user').setDescription('The user to add').setRequired(true))
            .addStringOption((opt) =>
                opt.setName('reason').setDescription('Reason for adding the user').setRequired(false).setMaxLength(512)
            )
    )
    // create ticket for user
    .addSubcommand((sub) =>
        sub
            .setName('create')
            .setDescription('Create a new ticket targeting a user')
            .addUserOption((opt) =>
                opt.setName('user').setDescription('User targeted by this ticket').setRequired(true)
            )
            .addStringOption((opt) => opt.setName('title').setDescription('The title of the ticket').setRequired(true))
    )
    .addSubcommand((sub) =>
        sub
            .setName('deploy')
            .setDescription('Deploy the mod ticket system to a channel')
            .addChannelOption((option) =>
                option
                    .setName('channel')
                    .setDescription('Channel to deploy the ticket system to')
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(false)
            )
    )
    .setDescription('Ticket management commands')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels);

function resolveCommandArgs(interaction: ChatInputCommandInteraction): CommandArgs {
    const subcommand = interaction.options.getSubcommand() as SubCommand;
    if (subcommand === 'add-user') {
        return {
            subcommand,
            user: interaction.options.getUser('user', true),
            reason: interaction.options.getString('reason') || undefined,
        };
    } else if (subcommand === 'create') {
        return {
            subcommand,
            user: interaction.options.getUser('user', true),
            title: interaction.options.getString('title', true),
        };
    } else if (subcommand === 'deploy') {
        return {
            subcommand,
            channel: (interaction.options.getChannel('channel') as TextChannel) || (interaction.channel as TextChannel),
        };
    }

    throw new Error(`Unsupported subcommand: ${subcommand}`);
}

export const handleTicketCommand = async (
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> => {
    // TODO: Implement ticket command handling
    await interaction.reply({
        content: '🚧 Ticket commands are under development.',
        ephemeral: true,
    });

    return { status: 'success', message: 'Command acknowledged' };
};
