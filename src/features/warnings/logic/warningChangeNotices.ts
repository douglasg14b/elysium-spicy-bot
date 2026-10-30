import type { APIEmbedField, EmbedBuilder, Guild } from 'discord.js';
import type { Warning, WarningActor } from '../data/warningsSchema';
import type { WarningChange } from './editGuildWarning';
import {
    postWarningNotice,
    truncateField,
    warningNoticeEmbed,
    type PostWarningNoticeDependencies,
    type WarningNoticeStatus,
} from './warningNotice';

/** The mod-log notices for a warning's release and its edits, beside `warningIssuedNotice.ts`'s. */

/**
 * The mod-log embed for a released warning — whose, who released it, the rule, the slug and
 * why — read from the saved row, so the notice says what the record says.
 *
 * Throws for a row with no releaser or no reason: every release writes both, so a row
 * without them was not just released, and posting a notice for it would be a lie.
 * (`postWarningNotice` turns the throw into `failed`.)
 */
export function buildWarningReleasedNoticeEmbed(warning: Warning): EmbedBuilder {
    if (!warning.clearedById || !warning.clearReason) {
        throw new Error(`Warning ${warning.slug} has no releaser or reason recorded, so it has no release notice.`);
    }

    return warningNoticeEmbed('Warning released').addFields(
        { name: 'Member', value: `<@${warning.userId}>`, inline: true },
        { name: 'Released by', value: `<@${warning.clearedById}>`, inline: true },
        { name: 'Rule', value: truncateField(warning.rule), inline: false },
        { name: 'Slug', value: `\`${warning.slug}\``, inline: true },
        { name: 'Reason', value: truncateField(warning.clearReason), inline: false }
    );
}

export type WarningEditedNoticeInput = {
    readonly warning: Warning;
    readonly editedBy: WarningActor;
    readonly changes: readonly WarningChange[];
};

/**
 * The fields one change shows. The rule and the drop-off fit `before → after` in one field;
 * a description (up to 1000 characters a side) gets a field for each side, so both arrive
 * whole — the row keeps only the last edit, so this notice is the only record of what was
 * there before.
 */
function changeFields(change: WarningChange): APIEmbedField[] {
    switch (change.field) {
        case 'rule':
            return [{ name: 'Rule', value: `${change.before} → ${change.after}`, inline: false }];
        case 'dropsOffOn':
            return [{ name: 'Drop-off', value: `${change.before} → ${change.after}`, inline: false }];
        case 'description':
            return [
                { name: 'Description (before)', value: truncateField(change.before), inline: false },
                { name: 'Description (after)', value: truncateField(change.after), inline: false },
            ];
    }
}

/** The mod-log embed for an edited warning: whose, who edited it, the slug, and each changed field. */
export function buildWarningEditedNoticeEmbed(input: WarningEditedNoticeInput): EmbedBuilder {
    return warningNoticeEmbed('Warning edited').addFields(
        { name: 'Member', value: `<@${input.warning.userId}>`, inline: true },
        { name: 'Edited by', value: `<@${input.editedBy.id}>`, inline: true },
        { name: 'Slug', value: `\`${input.warning.slug}\``, inline: true },
        ...input.changes.flatMap(changeFields)
    );
}

/** Post the released notice for a warning just released. Never throws; the status says how it went. */
export function notifyWarningReleased(
    guild: Guild,
    warning: Warning,
    dependencies: PostWarningNoticeDependencies = {}
): Promise<WarningNoticeStatus> {
    return postWarningNotice(guild, () => buildWarningReleasedNoticeEmbed(warning), dependencies);
}

/** Post the edited notice. Never throws; the status says how it went. */
export function notifyWarningEdited(
    guild: Guild,
    input: WarningEditedNoticeInput,
    dependencies: PostWarningNoticeDependencies = {}
): Promise<WarningNoticeStatus> {
    return postWarningNotice(guild, () => buildWarningEditedNoticeEmbed(input), dependencies);
}
