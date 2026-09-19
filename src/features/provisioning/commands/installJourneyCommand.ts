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
import { getJourney, listJourneys } from '../journeys/journeyRegistry';
import type { InstallPlan, PlanAction } from '../logic/installPlan';
import { isPlanApplicable } from '../logic/installPlan';
import type { ResourceKind } from '../logic/resourceDeclaration';
import { journeyNeedsStaffRoles, journeyNeedsSubject } from '../logic/resourceDeclaration';
import { previewInstall } from '../provisioningService';

/**
 * `/install-journey` — build a plan and show it. Nothing is mutated here.
 *
 * Plan and apply are deliberately two interactions: the requirement is that a live
 * server is never silently mutated, and a command that previewed and applied in one
 * gesture would meet the letter of "show a plan" while defeating it.
 */
export function buildInstallJourneyCommand(): SlashCommandBuilder {
    const builder = new SlashCommandBuilder()
        .setName('install-journey')
        .setDescription('Preview the channels, categories and roles a journey needs')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild);

    // Built from the registry at call time, not captured at module load. A
    // module-level constant would snapshot an empty registry and silently offer no
    // choices, since journeys register during feature init.
    builder.addStringOption((option) =>
        option
            .setName('journey')
            .setDescription('Which journey to install')
            .setRequired(true)
            .addChoices(
                ...listJourneys().map((journey) => ({
                    name: journey.name,
                    value: journey.journeyKey,
                }))
            )
    );

    // Staff roles are a guild fact the journey cannot know: a portable declaration
    // says "staff can see this", and *which* roles those are differs per server.
    // Supplied per-install until shared guild settings exist (PRD §5.12), which is
    // where this belongs permanently. Optional, because a journey that never names
    // the staff audience does not need it.
    for (const slot of STAFF_ROLE_SLOTS) {
        builder.addRoleOption((option) =>
            option
                .setName(slot)
                .setDescription('A role treated as staff by this journey (optional)')
                .setRequired(false)
        );
    }

    return builder;
}

/**
 * Option names for staff roles.
 *
 * Discord has no multi-role option type, so several single-role options stand in.
 * Three is a judgement call, not a limit anyone asked for: it covers the common
 * admin/mod/helper split, and a journey needing more is a signal that guild settings
 * should own this rather than the command.
 */
const STAFF_ROLE_SLOTS = ['staff-role', 'staff-role-2', 'staff-role-3'] as const;

/** Collect whichever staff roles the operator supplied, in order, de-duplicated. */
function readStaffRoleIds(interaction: ChatInputCommandInteraction): string[] {
    const ids = STAFF_ROLE_SLOTS.map((slot) => interaction.options.getRole(slot)?.id).filter(
        (id): id is string => Boolean(id)
    );

    return [...new Set(ids)];
}

/** Custom id prefix for the apply button. */
export const INSTALL_JOURNEY_APPLY_ID = 'provisioning:apply';

/** Discord's hard limit on a component custom id. */
const CUSTOM_ID_LIMIT = 100;

/**
 * Encode the apply button's identity: which journey, and which roles are staff.
 *
 * The staff roles have to survive the round trip, because the handler resolves the
 * same permission intents the plan was built from and cannot see the command's
 * options. A snowflake is ~19 characters, so this fits two or three roles and then
 * runs out — returns `undefined` rather than truncating, since a silently dropped
 * staff role produces a channel missing an audience it was promised.
 */
export function buildApplyCustomId(
    journeyKey: string,
    staffRoleIds: readonly string[]
): string | undefined {
    const parts = [INSTALL_JOURNEY_APPLY_ID, journeyKey];
    if (staffRoleIds.length > 0) parts.push(staffRoleIds.join(','));

    const customId = parts.join(':');
    return customId.length <= CUSTOM_ID_LIMIT ? customId : undefined;
}

/** The inverse of `buildApplyCustomId`. */
export function parseApplyCustomId(customId: string): {
    journeyKey: string;
    staffRoleIds: string[];
} {
    const rest = customId.slice(`${INSTALL_JOURNEY_APPLY_ID}:`.length);
    const [journeyKey, staffRoles] = rest.split(':');

    return {
        journeyKey,
        staffRoleIds: staffRoles ? staffRoles.split(',').filter(Boolean) : [],
    };
}

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
    const journey = getJourney(journeyKey);
    if (!journey) {
        await interaction.reply({
            content: `❌ No journey named \`${journeyKey}\` is known to this bot.`,
            ephemeral: true,
        });
        return commandError(`Unknown journey ${journeyKey}`);
    }

    // Both questions are asked of the declaration, never assumed. They are genuinely
    // different: a subject cannot exist at install time, whereas staff roles simply
    // have to be supplied.
    if (journeyNeedsSubject(journey)) {
        await interaction.reply({
            content:
                `❌ **${journey.name}** declares a resource whose permissions name a *subject* ` +
                `(the specific member a resource is about). A subject only exists while a flow ` +
                `runs, so this journey cannot be installed as shared guild structure.`,
            ephemeral: true,
        });
        return commandError(`Journey ${journeyKey} needs a subject`);
    }

    const staffRoleIds = readStaffRoleIds(interaction);

    if (journeyNeedsStaffRoles(journey) && staffRoleIds.length === 0) {
        await interaction.reply({
            content:
                `❌ **${journey.name}** grants access to staff, so this install needs to know ` +
                `which roles are staff on this server. Re-run with the \`staff-role\` option set.`,
            ephemeral: true,
        });
        return commandError(`Journey ${journeyKey} needs staff roles`);
    }

    // Building a plan reads the guild's channel and role caches, which can be cold on
    // a large server. Defer first — the 3-second acknowledgement deadline is an
    // invariant, not an optimisation.
    await interaction.deferReply({ ephemeral: true });

    try {
        const plan = await previewInstall({
            guild: interaction.guild,
            journey,
            staffRoleIds,
        });

        // Staff roles travel in the custom id, because the apply handler cannot see
        // the command's options and must resolve the same permissions this plan was
        // built from. Guarded against Discord's 100-character limit below.
        const customId = buildApplyCustomId(journey.journeyKey, staffRoleIds);

        const components =
            isPlanApplicable(plan) && customId
                ? [
                      new ActionRowBuilder<ButtonBuilder>().addComponents(
                          new ButtonBuilder()
                              .setCustomId(customId)
                              .setLabel('Apply')
                              .setStyle(ButtonStyle.Success)
                      ),
                  ]
                : [];

        if (isPlanApplicable(plan) && !customId) {
            // Rather than silently dropping a staff role and installing a channel
            // with the wrong audience.
            await interaction.editReply({
                content:
                    '❌ Too many staff roles to carry through the Apply button. Re-run with fewer, ' +
                    'or install this journey once shared guild settings can hold them.',
                embeds: [],
            });
            return commandError('Apply custom id would exceed the Discord limit');
        }

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
