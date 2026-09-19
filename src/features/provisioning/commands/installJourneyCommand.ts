import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChatInputCommandInteraction,
    EmbedBuilder,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { JOURNEYS } from '../journeys/onboardingJourney';
import type { InstallPlan, PlanAction } from '../logic/installPlan';
import { isPlanApplicable } from '../logic/installPlan';
import type { ResourceKind } from '../logic/resourceDeclaration';
import { previewInstall } from '../provisioningService';

/**
 * `/install-journey` — build a plan and show it. Nothing is mutated here.
 *
 * Plan and apply are deliberately two interactions: the requirement is that a live
 * server is never silently mutated, and a command that previewed and applied in one
 * gesture would meet the letter of "show a plan" while defeating it.
 */
export const installJourneyCommand = new SlashCommandBuilder()
    .setName('install-journey')
    .setDescription('Preview the channels, categories and roles a journey needs')
    .addStringOption((option) =>
        option
            .setName('journey')
            .setDescription('Which journey to install')
            .setRequired(true)
            .addChoices(
                ...[...JOURNEYS.values()].map((journey) => ({
                    name: journey.name,
                    value: journey.journeyKey,
                }))
            )
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild);

/** Custom id prefix for the apply button. The journey key is appended. */
export const INSTALL_JOURNEY_APPLY_ID = 'provisioning:apply';

// Typed against the unions rather than `Record<string, string>`, so adding a plan
// action or a resource kind fails the build here instead of rendering `undefined`
// to an operator deciding whether to mutate their server.
const ACTION_LABEL: Record<PlanAction, string> = {
    create: '🆕 Create',
    adopt: '🔗 Adopt',
    reuse: '✅ Already bound',
    blocked: '⛔ Needs a decision',
};

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
};

/**
 * Render a plan as something an operator can actually check before approving.
 *
 * Every item is listed, including the ones needing no work — "what will this do to my
 * server" is only answerable if the unchanged things are visible too.
 */
export function buildPlanEmbed(plan: InstallPlan, journeyName: string): EmbedBuilder {
    const lines = plan.items.map((item) => {
        const detail = item.reason ? `\n   ↳ ${item.reason}` : '';
        return `${ACTION_LABEL[item.action]} ${KIND_LABEL[item.kind]} **${item.name}**${detail}`;
    });

    const embed = new EmbedBuilder()
        .setTitle(`Install plan — ${journeyName}`)
        .setDescription(lines.join('\n') || '_Nothing declared._')
        .setColor(isPlanApplicable(plan) ? 0x57f287 : 0xed4245);

    if (plan.blockers.length > 0) {
        embed.addFields({
            name: '⛔ Blockers',
            value: plan.blockers.map((blocker) => `• ${blocker}`).join('\n'),
        });
    }

    embed.setFooter({
        text: isPlanApplicable(plan)
            ? 'Nothing has been changed yet. Press Apply to make these changes.'
            : 'This plan cannot be applied until the problems above are resolved.',
    });

    return embed;
}

export async function handleInstallJourney(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.guild) {
        await interaction.reply({
            content: '❌ This command can only be used in a server.',
            ephemeral: true,
        });
        return commandError('Not in guild');
    }

    const journeyKey = interaction.options.getString('journey', true);
    const journey = JOURNEYS.get(journeyKey);
    if (!journey) {
        await interaction.reply({
            content: `❌ No journey named \`${journeyKey}\` is known to this bot.`,
            ephemeral: true,
        });
        return commandError(`Unknown journey ${journeyKey}`);
    }

    // Building a plan reads the guild's channel and role caches, which can be cold on
    // a large server. Defer first — the 3-second acknowledgement deadline is an
    // invariant, not an optimisation.
    await interaction.deferReply({ ephemeral: true });

    try {
        const plan = await previewInstall({
            guild: interaction.guild,
            journey,
            // The onboarding journey declares no subject-scoped resource, so it needs
            // no staff roles. A journey that does will be refused by the permission
            // grid with a message naming what is missing, rather than silently
            // producing a channel with the wrong audience.
            staffRoleIds: [],
        });

        const components = isPlanApplicable(plan)
            ? [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                      new ButtonBuilder()
                          .setCustomId(`${INSTALL_JOURNEY_APPLY_ID}:${journey.journeyKey}`)
                          .setLabel('Apply')
                          .setStyle(ButtonStyle.Success)
                  ),
              ]
            : [];

        await interaction.editReply({
            embeds: [buildPlanEmbed(plan, journey.name)],
            components,
        });

        return commandSuccess(`Previewed install for ${journey.journeyKey}`);
    } catch (error) {
        // Detail to the log rather than to Discord. A declaration error here is a
        // developer bug, not something an operator can resolve from the message.
        console.error('[provisioning] Failed to build install plan:', error);
        await interaction.editReply({
            content: '❌ Could not build the install plan. Check the bot logs for details.',
        });
        return commandError('Failed to build plan');
    }
}
