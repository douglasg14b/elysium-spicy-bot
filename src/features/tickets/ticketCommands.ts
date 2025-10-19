import { ChatInputCommandInteraction, SlashCommandBuilder, TextChannel } from 'discord.js';
import { InteractionHandlerResult } from '../../features-system/commands/types';

export const TICKETS_COMMAND = 'tickets';

type SubCommand = 'add-user' | 'create';
type CommandArgs =
    | {
          subcommand: 'add-user';
          user: string;
          reason?: string;
      }
    | {
          subcommand: 'create';
          user: string;
          title: string;
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
    .setDescription('Ticket management commands');

function resolveCommandArgs(interaction: ChatInputCommandInteraction): CommandArgs {
    const subcommand = interaction.options.getSubcommand() as SubCommand;
    if (subcommand === 'add-user') {
        return {
            subcommand,
            user: interaction.options.getUser('user', true).id,
            reason: interaction.options.getString('reason') || undefined,
        };
    } else if (subcommand === 'create') {
        return {
            subcommand,
            user: interaction.options.getUser('user', true).id,
            title: interaction.options.getString('title', true),
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
