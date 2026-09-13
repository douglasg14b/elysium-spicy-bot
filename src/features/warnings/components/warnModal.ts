import {
    ActionRowBuilder,
    LabelBuilder,
    ModalBuilder,
    ModalSubmitInteraction,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { commandAuditLogRepo } from '../../../features-system/commands-audit/data';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { jsonIfy } from '../../../shared';
import type { Warning } from '../data/warningsSchema';
import {
    WARN_DATE_INPUT_MAX_LENGTH,
    WARN_DESCRIPTION_MAX_LENGTH,
    WARN_RULE_MAX_LENGTH,
    WARNING_DATE_PLACEHOLDER,
    WARNING_DEFAULT_DURATION_MONTHS,
} from '../constants';
import { issueGuildWarning } from '../logic/issueGuildWarning';
import { formatWarnSuccessMessage, notifyWarningIssued } from '../logic/warningIssuedNotice';
import {
    addCalendarMonths,
    calendarDateFromUtcMidnight,
    formatCalendarDate,
    getPacificCalendarDate,
    type WarningDateErrorKind,
} from '../logic/warningDates';
import { memberHasModerateMembers } from '../logic/warningPermissions';

export const WARN_MODAL_ID = 'warn_issue_modal';

export const WARN_USER_INPUT_ID = 'warn_user_input';
export const WARN_RULE_INPUT_ID = 'warn_rule_input';
export const WARN_DESCRIPTION_INPUT_ID = 'warn_description_input';
export const WARN_ISSUED_INPUT_ID = 'warn_issued_input';
export const WARN_EXPIRES_INPUT_ID = 'warn_expires_input';

function warningDateErrorCopy(kind: WarningDateErrorKind): string {
    switch (kind) {
        case 'invalid-issued':
            return `Issued date has to be ${WARNING_DATE_PLACEHOLDER}. Time travel spelling doesn't count.`;
        case 'invalid-expires':
            return `Drop-off date has to be ${WARNING_DATE_PLACEHOLDER}.`;
        case 'issued-in-future':
            return "Issued date can't be in the future. Backdate all you want — just not tomorrow.";
        case 'expires-not-after-issued':
            return 'Drop-off has to be after the issued date, or this warning is already a ghost.';
        case 'expires-already-passed':
            return 'That drop-off date is already in the past. Pick a future one or leave it blank for six months.';
    }
}

function readOptionalTextInput(interaction: ModalSubmitInteraction, customId: string): string {
    try {
        return interaction.fields.getTextInputValue(customId);
    } catch {
        return '';
    }
}

async function logWarnIssuance(
    interaction: ModalSubmitInteraction,
    warning: Warning,
    executionTimeMs: number
): Promise<void> {
    try {
        const channelName =
            (interaction.channel && 'name' in interaction.channel ? interaction.channel.name : 'unknown') ||
            'unknown';

        await commandAuditLogRepo.insert({
            command: 'warn',
            subcommand: null,
            channelId: interaction.channelId,
            channelName,
            guildId: interaction.guildId ?? 'none',
            guildName: interaction.guild ? interaction.guild.name : 'Not A Guild',
            userId: interaction.user.id,
            userName: interaction.user.username,
            userDiscriminator: interaction.user.discriminator || null,
            parameters: jsonIfy({
                slug: warning.slug,
                targetUserId: warning.userId,
                rule: warning.rule,
            }),
            result: 'success',
            resultMessage: warning.slug,
            resultData: jsonIfy({ slug: warning.slug, targetUserId: warning.userId }),
            executionTimeMs,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[warnings] Error logging warn issuance:', error);
    }
}

export function WarnModalComponent() {
    function buildComponent(now: Date = new Date()): ModalBuilder {
        const today = getPacificCalendarDate(now);
        const defaultExpires = addCalendarMonths(today, WARNING_DEFAULT_DURATION_MONTHS);

        const userLabel = new LabelBuilder()
            .setLabel('User')
            .setUserSelectMenuComponent(
                new UserSelectMenuBuilder()
                    .setCustomId(WARN_USER_INPUT_ID)
                    .setMaxValues(1)
                    .setPlaceholder('Select who earned this')
            );

        const ruleInput = new TextInputBuilder()
            .setCustomId(WARN_RULE_INPUT_ID)
            .setLabel('Rule broken')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('What rule did they blow through?')
            .setRequired(true)
            .setMaxLength(WARN_RULE_MAX_LENGTH);

        const descriptionInput = new TextInputBuilder()
            .setCustomId(WARN_DESCRIPTION_INPUT_ID)
            .setLabel('Description')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('How they did it. Be specific enough that future-you remembers.')
            .setRequired(true)
            .setMaxLength(WARN_DESCRIPTION_MAX_LENGTH);

        const issuedInput = new TextInputBuilder()
            .setCustomId(WARN_ISSUED_INPUT_ID)
            .setLabel('Issued date')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(formatCalendarDate(today))
            .setRequired(false)
            .setMaxLength(WARN_DATE_INPUT_MAX_LENGTH);

        const expiresInput = new TextInputBuilder()
            .setCustomId(WARN_EXPIRES_INPUT_ID)
            .setLabel('Drop-off date')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(formatCalendarDate(defaultExpires))
            .setRequired(false)
            .setMaxLength(WARN_DATE_INPUT_MAX_LENGTH);

        return new ModalBuilder()
            .setCustomId(WARN_MODAL_ID)
            .setTitle('Issue Warning')
            .addLabelComponents(userLabel)
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>({ components: [ruleInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [descriptionInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [issuedInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [expiresInput] })
            );
    }

    async function handler(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
            return commandError('This command can only be used in a server.');
        }

        if (!memberHasModerateMembers(interaction.memberPermissions)) {
            return commandError('Cute try, but you need Moderate Members to hand out warnings.');
        }

        const selectedUser = interaction.fields.getSelectedUsers(WARN_USER_INPUT_ID)?.first();
        if (!selectedUser) {
            return commandError('Pick a member first. Warnings do not hover in the abstract.');
        }

        const startedAt = Date.now();
        await interaction.deferReply({ ephemeral: true });

        let warning: Warning;
        try {
            const result = await issueGuildWarning({
                guildId: interaction.guildId,
                userId: selectedUser.id,
                issuerId: interaction.user.id,
                rule: interaction.fields.getTextInputValue(WARN_RULE_INPUT_ID),
                description: interaction.fields.getTextInputValue(WARN_DESCRIPTION_INPUT_ID),
                issuedInput: readOptionalTextInput(interaction, WARN_ISSUED_INPUT_ID),
                expiresInput: readOptionalTextInput(interaction, WARN_EXPIRES_INPUT_ID),
            });

            if (!result.ok) {
                const message =
                    result.kind === 'empty-rule'
                        ? 'Rule cannot be empty. Name the line they crossed.'
                        : result.kind === 'empty-description'
                          ? 'Description cannot be empty. Tell the story.'
                          : warningDateErrorCopy(result.kind);

                await interaction.editReply({ content: message });
                return commandError(message);
            }

            warning = result.warning;
        } catch (error) {
            console.error('[warnings] Failed to issue warning:', error);

            await interaction.editReply({
                content: 'Could not save that warning. Check /warnings before you try again.',
            });

            return commandError(error instanceof Error ? error.message : 'Unknown error');
        }

        const expiresLabel = formatCalendarDate(calendarDateFromUtcMidnight(warning.expiresAt));
        const noticeStatus = await notifyWarningIssued(interaction.guild, warning);

        await interaction.editReply({
            content: formatWarnSuccessMessage(warning.userId, warning.slug, expiresLabel, noticeStatus),
            allowedMentions: { users: [] },
        });

        await logWarnIssuance(interaction, warning, Date.now() - startedAt);

        return commandSuccess();
    }

    return {
        handler,
        component: buildComponent(),
        buildComponent,
        interactionId: WARN_MODAL_ID,
    };
}
