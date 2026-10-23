import type { CategoryChannel, Guild } from 'discord.js';
import type { Transaction } from 'kysely';
import type { Database } from '../../../features-system/data-persistence/database';
import {
    describeDiscordError,
    describeOtherHolder,
    existsInGuildAs,
    loadGuildOwnership,
    resourceBindingsRepo,
    TICKETS_OWNER,
} from '../../provisioning';
import { ticketingRepo } from '../data/ticketingRepo';
import type { BoundTicketCategory } from '../data/ticketingSchema';
import { validateTicketCategoryPermissions } from '../utils/validateTicketCategoriesPermissions';
import { createTicketCategory } from './createTicketCategory';

/**
 * Turning an operator's category picks into recorded categories: the part the settings
 * save and the type save share.
 *
 * A pick is an existing category by id, or a name the bot creates. So a save changes the
 * guild as well as the config, and runs in the order an install does: check every pick
 * first, then create, then write once — re-checking the adopted ones on the write's own
 * transaction — and a create that fails keeps what was already made.
 */

/** What the operator chose for one category: an existing one by id, or a name to create. */
export type TicketCategoryPick = { readonly discordId: string } | { readonly name: string };

/** One category to check, make if named, and record under `resourceKey`. */
export interface CategoryPickTarget {
    /** The ticket binding row it is recorded under: a slot, or `typeCategoryKey`. */
    readonly resourceKey: string;
    /** The slot in a sentence (`describeCategorySlot`), for every message about this pick. */
    readonly described: string;
    readonly pick: TicketCategoryPick;
    /** The category the row holds now, so re-sending it is "keep", not "adopt". */
    readonly currentDiscordId: string | null;
}

/** A pick that names a category to create. */
export type NamedCategoryPick = CategoryPickTarget & { readonly pick: { readonly name: string } };

/** A category ready to record, and how to name its slot if the record is refused. */
export interface CategoryChange {
    readonly binding: BoundTicketCategory;
    readonly described: string;
}

/**
 * Guilds whose ticket categories are being saved right now — by the settings save or a
 * type save, which share it.
 *
 * Either can create categories, so two at once — two tabs, a double submit, a type and
 * the settings — could each create one. The second is refused rather than queued, the
 * same rule as the journey lock, and for the same reason: it was composed against
 * categories the first is changing. In-process only; the bot is one process.
 */
const saving = new Set<string>();

/** Run `save` holding the guild's category lock, or answer `busy()` when another save holds it. */
export async function withCategorySaveLock<T>(guildId: string, busy: () => T, save: () => Promise<T>): Promise<T> {
    if (saving.has(guildId)) return busy();
    saving.add(guildId);
    try {
        return await save();
    } finally {
        saving.delete(guildId);
    }
}

export type CheckedCategoryPicks =
    | { readonly ok: false; readonly message: string }
    | {
          readonly ok: true;
          /** Journey names for the re-check's messages, read once here. */
          readonly journeyNames: ReadonlyMap<string, string>;
          /** Existing categories to adopt, by row key. A re-sent current id is absent: it is a keep. */
          readonly adopted: ReadonlyMap<string, CategoryChange>;
          /** Names to create, in pick order. */
          readonly toCreate: readonly NamedCategoryPick[];
      };

/**
 * Check every pick before changing anything — including that nobody else holds it: a
 * category belongs to one owner, and a journey's is not the ticket system's to adopt.
 */
export async function checkCategoryPicks(guild: Guild, targets: readonly CategoryPickTarget[]): Promise<CheckedCategoryPicks> {
    const ownership = await loadGuildOwnership(guild.id);
    const adopted = new Map<string, CategoryChange>();
    const toCreate: NamedCategoryPick[] = [];

    for (const target of targets) {
        const { pick, described } = target;
        if ('name' in pick) {
            toCreate.push({ ...target, pick });
            continue;
        }

        // Re-sending the bound id is "keep", not "adopt": a category the bot made stays
        // `created`, and its expected name stays what it was.
        if (target.currentDiscordId === pick.discordId) continue;

        // The same question install asks before an adopt, answered by the same function.
        if (!existsInGuildAs(guild, 'category', pick.discordId)) {
            return {
                ok: false,
                message: `The category picked for ${described} isn't a category in this server any more. Pick another, or type a name to have one made.`,
            };
        }
        const channel = guild.channels.cache.get(pick.discordId) as CategoryChannel;

        // Two picks sharing a category is one owner, so only *another* owner refuses.
        const holder = describeOtherHolder(ownership, channel.id, TICKETS_OWNER);
        if (holder) {
            return { ok: false, message: heldElsewhereMessage(described, channel.name, holder) };
        }

        const permissions = validateTicketCategoryPermissions(guild, channel);
        if (!permissions.valid) {
            return {
                ok: false,
                message: `The bot can't run tickets in "${channel.name}" (${described}): it's missing ${permissions.missingPermissions.join(', ')}.`,
            };
        }

        adopted.set(target.resourceKey, {
            binding: { name: channel.name, discordId: channel.id, provenance: 'adopted' },
            described,
        });
    }

    return { ok: true, journeyNames: ownership.journeyNames, adopted, toCreate };
}

export interface CreatedCategories {
    /** Every category made, by row key. */
    readonly created: ReadonlyMap<string, CategoryChange>;
    /** The names made, quoted, for a message that has to say they exist. */
    readonly madeNames: readonly string[];
    /** Why creating stopped, when it did. Everything made before it is in `created`. */
    readonly failure?: string;
}

/**
 * Create the typed names, one at a time. The same new name in two picks is one category,
 * as it was when the names themselves were the binding.
 */
export async function createNamedCategories(
    guild: Guild,
    toCreate: readonly NamedCategoryPick[],
    moderationRoleIds: readonly string[]
): Promise<CreatedCategories> {
    const created = new Map<string, CategoryChange>();
    const byName = new Map<string, BoundTicketCategory>();

    for (const { resourceKey, described, pick } of toCreate) {
        const already = byName.get(pick.name);
        if (already) {
            created.set(resourceKey, { binding: already, described });
            continue;
        }

        try {
            const category = await createTicketCategory({ guild, name: pick.name, moderationRoleIds: [...moderationRoleIds] });
            const binding: BoundTicketCategory = { name: pick.name, discordId: category.id, provenance: 'created' };
            byName.set(pick.name, binding);
            created.set(resourceKey, { binding, described });
        } catch (error) {
            return {
                created,
                madeNames: [...byName.keys()].map((name) => `"${name}"`),
                failure: `Discord would not create "${pick.name}" for ${described}: ${describeDiscordError(error)}`,
            };
        }
    }

    return { created, madeNames: [...byName.keys()].map((name) => `"${name}"`) };
}

/**
 * Record the changes on the config's transaction, re-checking every adopted one first.
 *
 * Creating can take seconds, and a journey install holds a different lock, so it may have
 * adopted the same category in between. On SQLite's one connection this read and the
 * write cannot interleave with anything. Only that pick is refused; everything else — a
 * category this save made — is still written, so nothing made is left unrecorded. Only
 * adopted picks are checked: a category this save just created can be held by nobody.
 *
 * Returns why each refused pick was refused; empty when every change was recorded.
 */
export async function recordCategoryChanges(
    guildId: string,
    changes: ReadonlyMap<string, CategoryChange>,
    journeyNames: ReadonlyMap<string, string>,
    transaction: Transaction<Database>
): Promise<string[]> {
    const current = { bindings: await resourceBindingsRepo.listByGuild(guildId, transaction), journeyNames };
    const writable = new Map<string, BoundTicketCategory>();
    const takenMeanwhile: string[] = [];

    for (const [resourceKey, { binding, described }] of changes) {
        const holder =
            binding.provenance === 'adopted' ? describeOtherHolder(current, binding.discordId, TICKETS_OWNER) : undefined;
        if (holder) takenMeanwhile.push(heldElsewhereMessage(described, binding.name, holder));
        else writable.set(resourceKey, binding);
    }

    await ticketingRepo.writeCategoryBindings(guildId, writable, transaction);
    return takenMeanwhile;
}

/** The refusal for a save that made categories and then could not write. */
export function writeFailedMessage(madeNames: readonly string[], whatFailed: string): string {
    return madeNames.length > 0
        ? `Made ${madeNames.join(', ')} in Discord but could not save ${whatFailed}. Pick ${madeNames.length === 1 ? 'it' : 'them'} from the list instead of typing the name again.`
        : `Could not save that — something else was editing this server’s ticket config at the same moment. Try again in a second.`;
}

/** Why a picked category cannot be a ticket category: somebody else holds it, named. */
function heldElsewhereMessage(described: string, categoryName: string, holder: string): string {
    return `"${categoryName}" (picked for ${described}) belongs to ${holder}, so tickets can't use it. Pick another category, or type a name to have one made.`;
}
