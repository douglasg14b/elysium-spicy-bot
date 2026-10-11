import type { BindingOwner, ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { isDiscordResourceKind } from './resourceDeclaration';

/**
 * Who holds what: the rules for telling one owner's bindings from another's.
 *
 * `resource_bindings` holds every owner's rows — each journey's and the ticket feature's
 * (see `BindingOwnerKind`). Two questions follow, and they are answered here so no
 * reader re-derives them:
 *
 *  - **Is this row one journey's own?** {@link isJourneyBinding}. Comparing `ownerKey`
 *    alone is the trap: a journey keyed `tickets` would take the ticket feature's rows as
 *    its own.
 *  - **Does somebody else already hold this object?** {@link ownerOf}. A category or
 *    channel belongs to one owner (Douglas, 2026-10-10); once one holds it, nobody else
 *    may pick or adopt it, and the refusal names the owner.
 */

/** Whether a binding row belongs to this journey. */
export function isJourneyBinding(
    binding: Pick<ResourceBindingEntity, 'ownerKind' | 'ownerKey'>,
    journeyKey: string
): boolean {
    return binding.ownerKind === 'journey' && binding.ownerKey === journeyKey;
}

function isSameOwner(binding: Pick<ResourceBindingEntity, 'ownerKind' | 'ownerKey'>, owner: BindingOwner): boolean {
    return binding.ownerKind === owner.kind && binding.ownerKey === owner.key;
}

/**
 * Another owner holding a **settled** binding for this object, or `undefined`.
 *
 * - Rows for `self` do not count: a journey re-adopting its own channel, or two ticket
 *   slots sharing one category, is one owner. Omit `self` to ask "does anyone hold it".
 * - An `intended` row has no id, so it never matches. (A settled row is required as
 *   well, so a hand-edited intent carrying an id is not taken as a claim.)
 * - If two other owners hold it — possible only with data from before the one-owner
 *   rule — the first in `(ownerKind, ownerKey)` order is named, which is the order
 *   `listByGuild` returns, so every surface names the same one.
 * - Only a Discord object's row is a holder; a `ticketType` row never is. Its `discordId` is a type key, which may be all
 *   digits, and a ticket type is not an object one owner holds: any number of journeys
 *   may use one. `loadGuildOwnership` already leaves those rows out; this holds for a
 *   caller that reads the rows itself (`setTicketSettings`'s write-time re-check).
 */
export function ownerOf(
    guildBindings: readonly ResourceBindingEntity[],
    discordId: string,
    self?: BindingOwner
): BindingOwner | undefined {
    const holder = guildBindings
        .filter(
            (binding) =>
                binding.discordId === discordId &&
                binding.state !== 'intended' &&
                isDiscordResourceKind(binding.kind) &&
                !(self && isSameOwner(binding, self))
        )
        .sort(
            (left, right) =>
                left.ownerKind.localeCompare(right.ownerKind) || left.ownerKey.localeCompare(right.ownerKey)
        )[0];

    return holder ? { kind: holder.ownerKind, key: holder.ownerKey } : undefined;
}

/**
 * Everything needed to say who holds what in one guild: every binding, and the journeys'
 * display names to name them by.
 *
 * Read once per request (`loadGuildOwnership`) and handed down, so a plan, a save or a
 * directory never asks the database a second time.
 */
export interface GuildOwnership {
    /**
     * Every binding of a **Discord object** in the guild, every owner's. A journey's
     * `ticketType` rows are left out (`loadGuildOwnership`): their `discordId` is a type
     * key, and no fence built from this list may read one as a snowflake.
     */
    readonly bindings: readonly ResourceBindingEntity[];
    /** Journey key → display name. A key absent here names a journey whose row is gone. */
    readonly journeyNames: ReadonlyMap<string, string>;
}

/**
 * An owner as an operator reads it: "the ticket system", or `journey "Onboarding"`.
 *
 * A journey whose row has been deleted still has bindings until they are torn down, so it
 * is named by its key rather than dropped.
 */
export function describeOwner(owner: BindingOwner, journeyNames: ReadonlyMap<string, string>): string {
    switch (owner.kind) {
        case 'tickets':
            return 'the ticket system';
        case 'journey':
            return `journey "${journeyNames.get(owner.key) ?? owner.key}"`;
        default: {
            const unreachable: never = owner.kind;
            throw new Error(`Unhandled binding owner kind: ${String(unreachable)}`);
        }
    }
}

/**
 * The other owner holding this object, already named for an operator, or `undefined`.
 *
 * The form every refusal wants: {@link ownerOf} then {@link describeOwner}.
 */
export function describeOtherHolder(
    ownership: GuildOwnership,
    discordId: string,
    self?: BindingOwner
): string | undefined {
    const holder = ownerOf(ownership.bindings, discordId, self);
    return holder ? describeOwner(holder, ownership.journeyNames) : undefined;
}
