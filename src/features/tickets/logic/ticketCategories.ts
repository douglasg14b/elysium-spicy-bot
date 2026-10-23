import type { CategoryChannel, Guild } from 'discord.js';
import { describeDiscordError, lookupBoundChannel } from '../../provisioning';
import { fail, ok, type Result } from '../../../shared';
import { ticketingRepo } from '../data/ticketingRepo';
import {
    isBoundTicketCategory,
    TICKET_CATEGORY_LABELS,
    type BoundTicketCategory,
    type ConfiguredTicketingConfig,
    type TicketCategoryBinding,
    type TicketCategorySlot,
    type TicketingConfig,
    type TicketTypeDefinition,
} from '../data/ticketingSchema';
import { createTicketCategory } from './createTicketCategory';

/**
 * Turning a category slot into the category, by id, recreating it only when it is gone.
 *
 * This is the whole fix for issue #22 at runtime. The old path matched `channel.name`
 * against a stored name and created a category when nothing matched, so renaming one in
 * Discord made the bot quietly start a second. Now a rename changes nothing — the id
 * still resolves — and the only thing that makes a new category is Discord saying the
 * bound one is `Unknown Channel` (`lookupBoundChannel`). A timeout or a 5xx fails the
 * ticket operation instead; recreating on those would mint exactly the duplicate this
 * replaces.
 */

/**
 * Recreations in flight, keyed by guild and the id that was deleted.
 *
 * Keyed on the deleted id rather than the slot for two reasons: two tickets opening right
 * after a deletion must make one category, not two; and an operator may point two slots
 * at one category, which must come back as one category with both slots repointed.
 *
 * In-process only, like the journey lock. The bot is one process; if that changes, this
 * is the second thing to replace.
 */
const recreating = new Map<string, Promise<Result<CategoryChannel>>>();

interface ResolveTicketCategoryInput {
    readonly guild: Guild;
    readonly config: ConfiguredTicketingConfig;
    /** The ticket's type, whose own category for the slot wins over the server's. */
    readonly definition: TicketTypeDefinition;
    readonly slot: TicketCategorySlot;
}

/**
 * Where a ticket of this type sits in this slot: the type's own category if it has one,
 * otherwise the server's. The one answer to that question — channel creation, the state
 * sync and the recreate's re-read all ask here, so they cannot disagree.
 */
export function ticketCategoryFor(config: TicketingConfig, type: string, slot: TicketCategorySlot): TicketCategoryBinding {
    return config.typeCategories.get(type)?.[slot] ?? config.categories[slot];
}

/**
 * A slot as an operator reads it in a sentence: "open tickets", or `"Verification" open
 * tickets` when it is a type's own.
 */
export function describeCategorySlot(slot: TicketCategorySlot, typeLabel?: string): string {
    return typeLabel ? `"${typeLabel}" ${TICKET_CATEGORY_LABELS[slot]}` : TICKET_CATEGORY_LABELS[slot];
}

/** The category a ticket of this type belongs in for a slot, recreated under its expected name if it was deleted. */
export async function resolveTicketCategory({
    guild,
    config,
    definition,
    slot,
}: ResolveTicketCategoryInput): Promise<Result<CategoryChannel>> {
    return resolveBinding(guild, config, definition, slot, config);
}

/**
 * `from` is the config the binding is read from: the caller's, or — after a gone lookup —
 * the stored one, so the slot is named as the binding actually being resolved.
 */
async function resolveBinding(
    guild: Guild,
    config: ConfiguredTicketingConfig,
    definition: TicketTypeDefinition,
    slot: TicketCategorySlot,
    from: TicketingConfig
): Promise<Result<CategoryChannel>> {
    const binding = ticketCategoryFor(from, definition.type, slot);
    const typeLabel = from.typeCategories.get(definition.type)?.[slot] ? definition.label : undefined;
    const described = describeCategorySlot(slot, typeLabel);

    // Only a type's own category can be unbound here — the server's slots are proved bound
    // by `isTicketingConfigConfigured` — and no save writes one unbound. Refused all the
    // same: the only way to act on it would be to find a category by name.
    if (!isBoundTicketCategory(binding)) {
        return fail(`The ${described} category is not linked to anything. Link it on the dashboard's ticket settings.`);
    }

    let lookup;
    try {
        lookup = await lookupBoundChannel(guild, 'category', binding.discordId);
    } catch (error) {
        return fail(
            `Could not reach the ${described} category "${binding.name}" in Discord, so nothing was moved: ${describeDiscordError(error)}`
        );
    }

    if (lookup.status === 'found') return ok(lookup.channel as CategoryChannel);

    /*
     * Gone — but the config this caller holds may be older than the stored one. A ticket
     * open reads the config, then fetches members and writes rows before it gets here, so
     * another ticket may already have replaced this category and saved the new id. The
     * in-flight map only covers recreates that overlap in time; this re-read covers the
     * ones that do not. Without it, the second ticket makes a second category: #22's
     * duplicate, through a stale read.
     */
    const storedConfig = (await ticketingRepo.get(guild.id))?.config;
    const stored = storedConfig ? ticketCategoryFor(storedConfig, definition.type, slot) : null;
    if (!stored?.discordId) {
        return fail(`The ${described} category is no longer linked to anything. Link it on the dashboard's ticket settings.`);
    }
    if (storedConfig && stored.discordId !== binding.discordId) {
        return resolveBinding(guild, config, definition, slot, storedConfig);
    }

    const key = `${guild.id}:${binding.discordId}`;
    const inFlight = recreating.get(key);
    if (inFlight) return inFlight;

    const recreation = recreateDeletedCategory(guild, config, binding).finally(() => recreating.delete(key));
    recreating.set(key, recreation);
    return recreation;
}

/**
 * Make the category again and point every slot that held the deleted id at it.
 *
 * The write is one compare-and-set statement on the slot rows — guild, the ticket owner,
 * and the deleted id — so every slot sharing the category is repointed together. No
 * config changes, so it does not go through `mutateConfig`. If the operator re-picked the
 * slot on the dashboard while this ran, their choice stands: nothing matches, the
 * category just made is deleted again, and this ticket operation fails rather than
 * landing a channel in a category the config no longer names.
 *
 * **Only the ticket feature's rows move.** A journey row on the same dead id stays dead,
 * and that journey's next install offers to recreate it as usual.
 *
 * **Accepted, not handled:** a create whose answer never arrives (a timeout after Discord
 * made it) fails this operation with the slot unchanged, and the next ticket makes
 * another. The stray carries the expected name, so the operator can spot and delete it.
 * Tickets record no intent that would close this — Douglas's call on 2026-10-10: one
 * empty duplicate category is the worst case, and he would delete it by hand.
 */
async function recreateDeletedCategory(
    guild: Guild,
    config: ConfiguredTicketingConfig,
    deleted: BoundTicketCategory
): Promise<Result<CategoryChannel>> {
    let category: CategoryChannel;
    try {
        category = await createTicketCategory({
            guild,
            name: deleted.name,
            moderationRoleIds: config.moderationRoles,
        });
    } catch (error) {
        return fail(
            `The ticket category "${deleted.name}" was deleted, and Discord would not let the bot make it again: ${describeDiscordError(error)}`
        );
    }

    let repointed: number;
    try {
        repointed = await ticketingRepo.repointCategory(guild.id, deleted.discordId, category.id);
    } catch (error) {
        console.error(
            `[tickets] Recreated deleted category "${deleted.name}" as ${category.id} in guild ${guild.id}, but could not save it:`,
            error
        );
        return fail(
            `The ticket category "${deleted.name}" was deleted. The bot made a new one but could not save it, so the next ticket may make another. Link it on the dashboard.`
        );
    }

    if (repointed === 0) {
        // Nothing references it and the bot made it moments ago, so it goes rather than
        // being left as an orphan the operator has to find.
        await category.delete('Replacement ticket category no longer needed: the slot was re-linked meanwhile').catch(
            (error: unknown) => {
                console.warn(
                    `[tickets] Made "${deleted.name}" as ${category.id} in guild ${guild.id} for a slot that was re-linked meanwhile, and could not delete it:`,
                    error
                );
            }
        );
        return fail('The ticket categories changed while the bot was replacing a deleted one. Try again.');
    }

    console.warn(
        `[tickets] Category "${deleted.name}" (${deleted.discordId}) was deleted in guild ${guild.id}; recreated as ${category.id}.`
    );
    return ok(category);
}
