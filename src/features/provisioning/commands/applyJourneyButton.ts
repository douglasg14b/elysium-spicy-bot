import { ButtonInteraction, EmbedBuilder, PermissionsBitField } from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { getJourney } from '../journeys/journeySource';
import { isPlanApplicable } from '../logic/installPlan';
import { installJourney, previewInstall } from '../provisioningService';
import { buildPlanEmbed, parseApplyCustomId } from './installJourneyCommand';

/**
 * Applies the plan shown by `/install-journey`.
 *
 * The plan is rebuilt here rather than carried across the interaction. That sounds
 * like it weakens "apply exactly what was approved", and it is the opposite: a
 * `custom_id` caps at 100 characters, so smuggling a plan through it would mean
 * truncating or re-deriving it anyway. Rebuilding and re-checking applicability means
 * a guild that changed between preview and press is caught, rather than a stale plan
 * being applied to a server it no longer describes.
 */
export async function handleApplyJourney(
    interaction: ButtonInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.guild) {
        await interaction.reply({
            content: '❌ This can only be used in a server.',
            ephemeral: true,
        });
        return commandError('Not in guild');
    }

    // The button lives on an ephemeral message, but a custom id is guessable and
    // provisioning mutates the server — so permission is re-checked at press time
    // rather than trusted from whoever ran the command.
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: '❌ You need Manage Server permissions to apply an install plan.',
            ephemeral: true,
        });
        return commandError('Insufficient permissions');
    }

    const { journeyKey, staffRoleIds } = parseApplyCustomId(interaction.customId);
    const journey = await getJourney(interaction.guild.id, journeyKey);
    if (!journey) {
        await interaction.reply({
            content: `❌ No journey named \`${journeyKey}\` exists in this server.`,
            ephemeral: true,
        });
        return commandError(`Unknown journey ${journeyKey}`);
    }

    // Creating several channels and a role will exceed the 3-second acknowledgement
    // deadline on its own, before rate limiting.
    await interaction.deferUpdate();

    try {
        const plan = await previewInstall({
            guild: interaction.guild,
            journey,
            staffRoleIds,
        });

        // The plan is rebuilt rather than carried through the custom id (which caps
        // at 100 characters). That means the operator approved the plan they *saw*,
        // and this is a different object — so if it no longer says the same thing,
        // the approval does not transfer and they are shown the new one instead.
        if (!isPlanApplicable(plan)) {
            await interaction.editReply({
                embeds: [buildPlanEmbed(plan, journey.name)],
                components: [],
            });
            return commandError(`Plan for ${journeyKey} is no longer applicable`);
        }

        const result = await installJourney({
            guild: interaction.guild,
            journey,
            approvedPlan: plan,
            staffRoleIds,
        });

        const embed = new EmbedBuilder()
            .setTitle(`Install — ${journey.name}`)
            .setColor(result.failure ? 0xed4245 : 0x57f287);

        // Render from the declaration's `kind`, not from the shape of the key. A
        // resource named `welcome-role` would otherwise be mentioned as a channel,
        // and `<#role-id>` renders as a dead link rather than an error.
        const kindByKey = new Map(
            journey.resources.map((resource) => [resource.key, resource.kind] as const)
        );
        const ACTION_ICON = { created: '🆕', adopted: '🔗', reused: '✅' } as const;

        const lines = result.applied.map((entry) => {
            const kind = kindByKey.get(entry.resourceKey);
            const label =
                kind === 'role'
                    ? `<@&${entry.discordId}>`
                    : kind === 'category'
                      ? `\`${entry.name}\``
                      : `<#${entry.discordId}>`;
            return `${ACTION_ICON[entry.action]} ${label}`;
        });

        embed.setDescription(lines.join('\n') || '_Nothing was applied._');

        if (result.failure) {
            // Partial application is a legitimate state: what is listed above is
            // real and bound, and re-running install converges rather than
            // duplicating.
            embed.addFields({
                name: '⛔ Stopped',
                value: `${result.failure}\n\nRe-run \`/install-journey\` to continue from here.`,
            });
        }

        await interaction.editReply({ embeds: [embed], components: [] });

        return result.failure
            ? commandError(`Install of ${journeyKey} stopped: ${result.failure}`)
            : commandSuccess(`Installed ${journeyKey}`);
    } catch (error) {
        // The detail goes to the log, not to Discord: an exception message can carry
        // internals an operator cannot act on. The named failures they *can* act on
        // come back through `result.failure`, which is written for them.
        console.error('[provisioning] Install failed:', error);
        await interaction.editReply({
            content: `❌ The install failed unexpectedly. Nothing further was changed — check the bot logs, then re-run \`/install-journey\` to see the current state.`,
            embeds: [],
            components: [],
        });
        return commandError('Install failed');
    }
}
