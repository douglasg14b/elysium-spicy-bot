import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { isPostedMessageRow, requireMessagePresence, type MessagePresence } from './lookupBoundMessage';
import {
    isDiscordResource,
    nonDiscordResourceKind,
    type DiscordResourceKind,
    type JourneyDeclaration,
    type ResourceKind,
} from './resourceDeclaration';

/**
 * Resources this journey installed and no longer declares.
 *
 * ## The gap this closes
 *
 * Remove a resource from a flow's Resources panel and the declaration goes away. The
 * **binding row and the Discord object both stay** — nothing deletes them, deliberately,
 * because deleting a live channel as a side effect of an edit is exactly the behaviour
 * `journeysRepo` and `flowJourneyLinksRepo` both have comments refusing to have.
 *
 * The result is a channel that nothing on any screen mentions. Install does not plan
 * it (no declaration). Drift does not report it (`buildJourneyDriftPlan` walks
 * declarations, and says why). Teardown's plan *does* include it, since
 * `buildUnpublishPlan` works from bindings — but only when the operator tears the whole
 * journey down, which is not what they want to do about one stray channel.
 *
 * So the object is real, ours, invisible, and permanent. This module names it.
 *
 * ## Why it is not drift
 *
 * Drift asks *is this still what we declared*. An orphan has no declaration to be
 * compared against, so the question does not apply — and "repair" would have nothing
 * to reconcile toward. It is a teardown question with two honest answers: **delete**
 * the object, or **forget** the row and leave the object alone. Both are destructive
 * in different directions, which is why this reports rather than decides.
 */

export interface OrphanedBinding {
    readonly bindingId: number;
    readonly resourceKey: string;
    readonly kind: ResourceKind;
    /** The name recorded at bind time. Diagnostics only — never a lookup key. */
    readonly name: string;
    /** Absent when the row was never settled, which makes it a `forget` either way. */
    readonly discordId?: string;
    /**
     * Whether the object is still in the guild.
     *
     * Decided by the caller, which is the only party holding a `Guild`. `false` means
     * forgetting the row is the whole of the cleanup — there is nothing left to delete.
     */
    readonly stillInGuild: boolean;
    /**
     * Whether deleting the object is permitted at all.
     *
     * `false` for an adopted binding: the operator told us it predates the journey, and
     * that promise does not lapse because the declaration was removed. The row may
     * still be forgotten; the object may not be touched.
     */
    readonly mayDelete: boolean;
    /**
     * Whether the install that recorded this row never completed.
     *
     * Distinct from `stillInGuild` because the two come apart in the case that
     * matters: a crash between creating the object and settling the row leaves a
     * never-settled row *with* a live object. Saying only "gone" or "here" would
     * describe that state wrongly either way.
     */
    readonly neverSettled: boolean;
}

export interface FindOrphanedBindingsInput {
    readonly journey: JourneyDeclaration;
    /**
     * This journey's own rows (`listByJourney`, which names `owner_kind = 'journey'`).
     * Never the guild's: the ticket feature's slot rows declare nothing here and would
     * all read as orphans.
     */
    readonly bindings: readonly ResourceBindingEntity[];
    /**
     * Whether a bound object is still present in the guild.
     *
     * A predicate rather than a `Guild` so this stays pure and testable — the same
     * split `detectResourceDrift` takes, for the same reason. Asked of Discord objects
     * only; a ticket type is branched off before it.
     */
    readonly existsInGuild: (kind: DiscordResourceKind, discordId: string) => boolean;
    /**
     * Whether each message this journey posted is still there, keyed by resource key
     * (`readMessagePresence`, over `bindings`). A message row is never in the guild's cache,
     * so `existsInGuild` cannot answer for it. Required when a posted message's row is met.
     */
    readonly messagePresence?: ReadonlyMap<string, MessagePresence>;
}

/**
 * Every binding whose resource key the journey no longer declares.
 *
 * Walks **bindings** rather than declarations — the mirror of `buildJourneyDriftPlan`,
 * which walks declarations. That is the whole difference between the two questions:
 * drift asks about things we still want and orphan-finding asks about things we have
 * and no longer asked for.
 */
export function findOrphanedBindings(
    input: FindOrphanedBindingsInput
): readonly OrphanedBinding[] {
    const declaredKeys = new Set(input.journey.resources.map((resource) => resource.key));

    return input.bindings
        .filter((binding) => !declaredKeys.has(binding.resourceKey))
        .map((binding) => {
            /*
             * A ticket type no longer declared: only its row can go. The type itself stays
             * in the ticket settings, as it does on uninstall, so it is never deletable.
             * Read as still there without asking the ticket feature: removing a type a
             * journey holds is refused (`deleteTicketType`), and a row about a type that
             * did vanish is forgotten all the same.
             */
            if (!isDiscordResource(binding)) {
                const kind = nonDiscordResourceKind(binding.kind);
                switch (kind) {
                    case 'ticketType':
                        return {
                            bindingId: binding.id,
                            resourceKey: binding.resourceKey,
                            kind: binding.kind,
                            name: binding.name,
                            stillInGuild: true,
                            mayDelete: false,
                            neverSettled: false,
                        };
                    /*
                     * A message no longer declared: still posted unless Discord said it is
                     * gone. One the bot could not read counts as still there — saying "gone"
                     * about a message that may be posted would invite forgetting the only
                     * record of it.
                     */
                    case 'message': {
                        const posted = isPostedMessageRow(binding);
                        const presence = posted
                            ? requireMessagePresence(input.messagePresence, binding, 'its leftovers were listed')
                            : undefined;
                        return {
                            bindingId: binding.id,
                            resourceKey: binding.resourceKey,
                            kind: binding.kind,
                            name: binding.name,
                            ...(binding.discordId ? { discordId: binding.discordId } : {}),
                            stillInGuild: posted && presence !== 'gone',
                            mayDelete: binding.state === 'created',
                            neverSettled: binding.state === 'intended',
                        };
                    }
                    default: {
                        const unreachable: never = kind;
                        throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
                    }
                }
            }

            return {
                bindingId: binding.id,
                resourceKey: binding.resourceKey,
                kind: binding.kind,
                name: binding.name,
                ...(binding.discordId ? { discordId: binding.discordId } : {}),
                /*
                 * Asked whenever there is an id to ask about, **including for an
                 * `intended` row**.
                 *
                 * The first version excluded `intended`, reasoning that such a row never
                 * reached the guild. That is the usual case and not the dangerous one: a
                 * crash between creating the channel and settling the row leaves
                 * `intended` with a live object behind it — the exact state the schema's
                 * crash-safety note describes. Excluding it made the report say "already
                 * gone from the server" about a channel sitting right there, so an
                 * operator forgetting the row would create precisely the invisible
                 * permanent object this module exists to eliminate, by the one route it
                 * was not looking at.
                 */
                stillInGuild:
                    !!binding.discordId && input.existsInGuild(binding.kind, binding.discordId),
                // The adoption promise survives the declaration that referenced it, and an
                // `intended` row is not ours to delete either — only `created` is.
                mayDelete: binding.state === 'created',
                neverSettled: binding.state === 'intended',
            };
        });
}

/**
 * What to tell an operator about one orphan, in words they can act on.
 *
 * States what *happened* before what can be done about it. An operator seeing this has
 * usually forgotten removing the resource, so "this is no longer declared" is the fact
 * that makes the rest make sense.
 */
export function describeOrphan(orphan: OrphanedBinding): string {
    const label = KIND_LABEL[orphan.kind];

    // First, because none of the sentences below is about a setting: a ticket type is
    // never gone from the server by our hand and never deletable.
    if (orphan.kind === 'ticketType') {
        return `**${orphan.name}** is no longer declared by this journey. The ticket type stays in your ticket settings, and flows that use it keep working — only the record can be removed.`;
    }

    if (!orphan.stillInGuild) {
        return `**${orphan.name}** is no longer declared by this journey, and the ${label} is already gone from the server. Only the leftover record remains.`;
    }

    // A message is posted rather than "in your server", and is only ever created here.
    if (orphan.kind === 'message') {
        return `**${orphan.name}** is no longer declared by this journey, but the message is still posted. Nothing installs or updates it any more.`;
    }

    // A live object behind a never-settled row: the install crashed partway. Neither
    // "already gone" nor "we made this" is true, so it gets its own sentence rather
    // than being rounded to whichever is closer.
    if (orphan.neverSettled) {
        return `**${orphan.name}** is no longer declared by this journey, and its record was never completed — but a ${label} matching it is still in your server. Check it before removing the record, because nothing will track it afterwards.`;
    }

    if (!orphan.mayDelete) {
        return `**${orphan.name}** is no longer declared by this journey. It was adopted rather than created here, so it will be left exactly where it is — only the record can be removed.`;
    }

    return `**${orphan.name}** is no longer declared by this journey, but the ${label} is still in your server. Nothing installs or updates it any more.`;
}

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
    ticketType: 'ticket type',
    message: 'message',
};
