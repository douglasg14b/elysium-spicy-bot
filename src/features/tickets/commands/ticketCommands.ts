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
import { TicketConfigModalComponent } from '../components/ticketConfigModal';
import { ticketingRepo } from '../data/ticketingRepo';

export const TICKETS_COMMAND = 'tickets';

type SubCommand = 'add-user' | 'create' | 'config';
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
          subcommand: 'config';
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
    .addSubcommand((sub) => sub.setName('config').setDescription('Configure the ticket system settings'))
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
    } else if (subcommand === 'config') {
        return {
            subcommand,
        };
    }

    throw new Error(`Unsupported subcommand: ${subcommand}`);
}

export const handleTicketCommand = async (
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> => {
    const args = resolveCommandArgs(interaction);

    if (args.subcommand === 'config') {
        if (!interaction.guild) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        // Check if user has manage server permissions
        if (!interaction.memberPermissions?.has('ManageGuild')) {
            return {
                status: 'error',
                message: '❌ You need Manage Server permissions to configure the ticket system.',
            };
        }

        try {
            // Get existing configuration if any
            const existingConfig = await ticketingRepo.get(interaction.guild.id);
            const currentConfig = existingConfig?.config;

            // Create and show the modal
            const modalComponent = TicketConfigModalComponent();
            const modal = modalComponent.component(currentConfig);

            await interaction.showModal(modal);
            return { status: 'success' };
        } catch (error) {
            console.error('Error showing ticket config modal:', error);
            return {
                status: 'error',
                message: '❌ Failed to open configuration modal. Please try again or contact an administrator.',
            };
        }
    }

    // TODO: Implement other ticket command handling
    await interaction.reply({
        content: '🚧 This ticket command is under development.',
        ephemeral: true,
    });

    return { status: 'success', message: 'Command acknowledged' };
};
