import type { Guild } from 'discord.js';
import { ticketingRepo } from '../data/ticketingRepo';
import { TICKET_CATEGORY_SLOTS, type TicketCategorySlot, type TicketingConfig } from '../data/ticketingSchema';
import { describeCategorySlot } from './ticketCategories';
import {
    checkCategoryPicks,
    createNamedCategories,
    recordCategoryChanges,
    withCategorySaveLock,
    writeFailedMessage,
    type CategoryPickTarget,
    type TicketCategoryPick,
} from './ticketCategoryChoices';

/**
 * Saving the ticket settings the dashboard owns: the three server-wide category slots and
 * the moderation roles.
 *
 * This changes the guild as well as the config, because a slot can be given a **name**
 * and the category is created on save. The check / create / write choreography is
 * `ticketCategoryChoices`', shared with the type save.
 *
 * Shaped like `setTicketTypes`: a discriminated result, so the route maps a reason to a
 * status rather than matching message text.
 */

/** What the operator chose for one slot. `null` leaves the slot exactly as it is. */
export type TicketCategoryChoice = TicketCategoryPick | null;

export interface SetTicketSettingsInput {
    readonly guild: Guild;
    readonly categories: Readonly<Record<TicketCategorySlot, TicketCategoryChoice>>;
    readonly moderationRoles: readonly string[];
}

export type SetTicketSettingsRefusal =
    | 'no-config'
    | 'invalid-input'
    | 'busy'
    | 'create-failed'
    | 'taken-meanwhile'
    | 'write-failed';

/** The refusals that still **saved** the rest — see {@link SetTicketSettingsResult}. */
type PartlySavedRefusal = Extract<SetTicketSettingsRefusal, 'create-failed' | 'taken-meanwhile'>;

/**
 * `create-failed` and `taken-meanwhile` are their own arm because they are the failures
 * that **saved**: every category that was made, and the roles, are stored, and `config`
 * is what was written. `taken-meanwhile` is an adopted category another owner claimed
 * while this save was creating — only that slot is left as it was. A required member
 * rather than an optional one on a shared arm, so a caller cannot forget that the guild
 * changed.
 */
export type SetTicketSettingsResult =
    | { ok: true; config: TicketingConfig }
    | { ok: false; reason: PartlySavedRefusal; message: string; config: TicketingConfig }
    | { ok: false; reason: Exclude<SetTicketSettingsRefusal, PartlySavedRefusal>; message: string };

export async function setTicketSettings(input: SetTicketSettingsInput): Promise<SetTicketSettingsResult> {
    return withCategorySaveLock(
        input.guild.id,
        () => ({
            ok: false,
            reason: 'busy',
            message: 'Another save of these settings is still running, so nothing was changed. Wait a moment and try again.',
        }),
        () => saveUnderGuard(input)
    );
}

async function saveUnderGuard({ guild, categories, moderationRoles }: SetTicketSettingsInput): Promise<SetTicketSettingsResult> {
    const current = await ticketingRepo.get(guild.id);
    if (!current?.config) {
        return {
            ok: false,
            reason: 'no-config',
            message:
                'This server has no ticket config yet. Run /deploy-ticket-system in Discord first, then come back and tune it here.',
        };
    }

    // 1. Check every picked category before changing anything.
    const targets: CategoryPickTarget[] = [];
    for (const slot of TICKET_CATEGORY_SLOTS) {
        const pick = categories[slot];
        if (!pick) continue;
        targets.push({
            resourceKey: slot,
            described: describeCategorySlot(slot),
            pick,
            currentDiscordId: current.config.categories[slot]?.discordId ?? null,
        });
    }
    const checked = await checkCategoryPicks(guild, targets);
    if (!checked.ok) return { ok: false, reason: 'invalid-input', message: checked.message };

    // 2. Create the typed names.
    const { created, madeNames, failure } = await createNamedCategories(guild, checked.toCreate, moderationRoles);

    // 3. Write once, with everything that now exists — including on a failed create, so a
    //    category that was made is never left unrecorded.
    let saved: TicketingConfig | null;
    let takenMeanwhile: string[] = [];
    try {
        saved = await ticketingRepo.mutateConfig(guild.id, async (row, transaction) => {
            takenMeanwhile = await recordCategoryChanges(
                guild.id,
                new Map([...checked.adopted, ...created]),
                checked.journeyNames,
                transaction
            );
            return { ...row.config, moderationRoles: [...new Set(moderationRoles)] };
        });
    } catch (error) {
        console.error('[tickets] Error saving ticket settings:', error);
        return { ok: false, reason: 'write-failed', message: writeFailedMessage(madeNames, 'the settings') };
    }

    if (!saved) {
        return {
            ok: false,
            reason: 'no-config',
            message: 'This server’s ticket config disappeared while saving. Run /deploy-ticket-system in Discord, then try again.',
        };
    }

    if (takenMeanwhile.length > 0) {
        const alsoFailed = failure ? ` ${failure}.` : '';
        return {
            ok: false,
            reason: 'taken-meanwhile',
            message: `${takenMeanwhile.join(' ')}${alsoFailed} Everything else was saved.`,
            config: saved,
        };
    }

    if (failure) {
        return { ok: false, reason: 'create-failed', message: `${failure}. Everything else was saved.`, config: saved };
    }

    return { ok: true, config: saved };
}
