import type { CategoryChannel, Guild } from 'discord.js';
import {
    describeDiscordError,
    describeOtherHolder,
    existsInGuildAs,
    loadGuildOwnership,
    resourceBindingsRepo,
    TICKETS_OWNER,
} from '../../provisioning';
import { ticketingRepo } from '../data/ticketingRepo';
import {
    TICKET_CATEGORY_LABELS,
    TICKET_CATEGORY_SLOTS,
    type BoundTicketCategory,
    type TicketCategorySlot,
    type TicketingConfig,
} from '../data/ticketingSchema';
import { validateTicketCategoryPermissions } from '../utils/validateTicketCategoriesPermissions';
import { createTicketCategory } from './createTicketCategory';

/**
 * Saving the ticket settings the dashboard owns: the three category slots and the
 * moderation roles.
 *
 * This changes the guild as well as the config, because a slot can be given a **name**
 * and the category is created on save. So it runs in the order an install does: check
 * everything first, then create, then write once; and a create that fails keeps what was
 * already made.
 *
 * Shaped like `setTicketTypes`: a discriminated result, so the route maps a reason to a
 * status rather than matching message text.
 */

/** What the operator chose for one slot. `null` leaves the slot exactly as it is. */
export type TicketCategoryChoice = { readonly discordId: string } | { readonly name: string } | null;

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

/**
 * Guilds whose ticket settings are being saved right now.
 *
 * A save can create categories, so two at once — two tabs, a double submit — could each
 * create one. The second is refused rather than queued, the same rule as the journey
 * lock, and for the same reason: it was composed against settings the first is changing.
 * In-process only; the bot is one process.
 */
const saving = new Set<string>();

export async function setTicketSettings(input: SetTicketSettingsInput): Promise<SetTicketSettingsResult> {
    const { guild } = input;
    if (saving.has(guild.id)) {
        return {
            ok: false,
            reason: 'busy',
            message: 'Another save of these settings is still running, so nothing was changed. Wait a moment and try again.',
        };
    }

    saving.add(guild.id);
    try {
        return await saveUnderGuard(input);
    } finally {
        saving.delete(guild.id);
    }
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

    // 1. Check every picked category before changing anything — including that nobody
    //    else holds it: a category belongs to one owner, and a journey's is not ours to
    //    adopt.
    const ownership = await loadGuildOwnership(guild.id);
    const changes: Partial<Record<TicketCategorySlot, BoundTicketCategory>> = {};
    const toCreate: { readonly slot: TicketCategorySlot; readonly name: string }[] = [];

    for (const slot of TICKET_CATEGORY_SLOTS) {
        const choice = categories[slot];
        if (!choice) continue;

        if ('name' in choice) {
            toCreate.push({ slot, name: choice.name });
            continue;
        }

        // Re-sending the bound id is "keep", not "adopt": a category the bot made stays
        // `created`, and its expected name stays what it was.
        if (current.config.categories[slot]?.discordId === choice.discordId) continue;

        // The same question install asks before an adopt, answered by the same function.
        if (!existsInGuildAs(guild, 'category', choice.discordId)) {
            return {
                ok: false,
                reason: 'invalid-input',
                message: `The category picked for ${TICKET_CATEGORY_LABELS[slot]} isn't a category in this server any more. Pick another, or type a name to have one made.`,
            };
        }
        const channel = guild.channels.cache.get(choice.discordId) as CategoryChannel;

        // Two slots sharing a category is one owner, so only *another* owner refuses.
        const holder = describeOtherHolder(ownership, channel.id, TICKETS_OWNER);
        if (holder) {
            return {
                ok: false,
                reason: 'invalid-input',
                message: heldElsewhereMessage(slot, channel.name, holder),
            };
        }

        const permissions = validateTicketCategoryPermissions(guild, channel);
        if (!permissions.valid) {
            return {
                ok: false,
                reason: 'invalid-input',
                message: `The bot can't run tickets in "${channel.name}" (${TICKET_CATEGORY_LABELS[slot]}): it's missing ${permissions.missingPermissions.join(', ')}.`,
            };
        }

        changes[slot] = { name: channel.name, discordId: channel.id, provenance: 'adopted' };
    }

    // 2. Create the typed names, one at a time. The same new name in two slots is one
    //    category, as it was when the names themselves were the binding.
    const created = new Map<string, BoundTicketCategory>();
    let failure: string | undefined;

    for (const { slot, name } of toCreate) {
        const already = created.get(name);
        if (already) {
            changes[slot] = already;
            continue;
        }

        try {
            const category = await createTicketCategory({ guild, name, moderationRoleIds: moderationRoles });
            const binding: BoundTicketCategory = { name, discordId: category.id, provenance: 'created' };
            created.set(name, binding);
            changes[slot] = binding;
        } catch (error) {
            failure = `Discord would not create "${name}" for ${TICKET_CATEGORY_LABELS[slot]}: ${describeDiscordError(error)}`;
            break;
        }
    }

    // 3. Write once, with everything that now exists — including on a failed create, so a
    //    category that was made is never left unrecorded.
    let saved: TicketingConfig | null;
    /** Why each slot the re-check below refused was refused: claimed since step 1. */
    const takenMeanwhile: string[] = [];
    try {
        saved = await ticketingRepo.mutateConfig(guild.id, async (row, transaction) => {
            /*
             * The step-1 check, again, on this transaction. Creating can take seconds,
             * and a journey install holds a different lock, so it may have adopted the
             * same category in between. On SQLite's one connection this read and the
             * write below cannot interleave with anything.
             *
             * Only that slot is refused; everything else — a category this save made, the
             * roles — is still written, so nothing made is left unrecorded. Only adopted
             * slots are checked: a category this save just created can be held by nobody.
             */
            const current = { bindings: await resourceBindingsRepo.listByGuild(guild.id, transaction), journeyNames: ownership.journeyNames };
            const writable: Partial<Record<TicketCategorySlot, BoundTicketCategory>> = {};
            for (const slot of TICKET_CATEGORY_SLOTS) {
                const change = changes[slot];
                if (!change) continue;
                const holder = change.provenance === 'adopted' ? describeOtherHolder(current, change.discordId, TICKETS_OWNER) : undefined;
                if (holder) takenMeanwhile.push(heldElsewhereMessage(slot, change.name, holder));
                else writable[slot] = change;
            }

            await ticketingRepo.writeCategorySlots(guild.id, writable, transaction);
            return { ...row.config, moderationRoles: [...new Set(moderationRoles)] };
        });
    } catch (error) {
        console.error('[tickets] Error saving ticket settings:', error);
        const madeNames = [...created.values()].map((binding) => `"${binding.name}"`);
        return {
            ok: false,
            reason: 'write-failed',
            message:
                madeNames.length > 0
                    ? `Made ${madeNames.join(', ')} in Discord but could not save the settings. Pick ${madeNames.length === 1 ? 'it' : 'them'} from the list instead of typing the name again.`
                    : 'Could not save that — something else was editing this server’s ticket config at the same moment. Try again in a second.',
        };
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

/** Why a picked category cannot be a ticket slot: somebody else holds it, named. */
function heldElsewhereMessage(slot: TicketCategorySlot, categoryName: string, holder: string): string {
    return `"${categoryName}" (picked for ${TICKET_CATEGORY_LABELS[slot]}) belongs to ${holder}, so tickets can't use it. Pick another category, or type a name to have one made.`;
}
