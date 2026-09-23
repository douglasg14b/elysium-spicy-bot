import { ticketsRepo, type TicketsExecutor, type TicketsRepo } from '../data/ticketsRepo';
import type { TicketStatus } from '../data/ticketsSchema';

/**
 * Whether anything is still holding a ticket type, and the refusal that says so.
 *
 * One question — *"would deleting this type break a record that did not ask?"* —
 * asked from the one place that can do the damage. Matched in structure to
 * `provisioning/logic/sharedJourneyGuard.ts`: the query and the refusal copy live
 * together in `logic/`, beside the rule that produces them, rather than in
 * `src/web/api/` where a Discord surface could not reach them.
 */

/** How many tickets hold a type, capped examples included, for a refusal an operator has to act on. */
export interface TicketTypeUsage {
    readonly openCount: number;
    readonly closedCount: number;
    readonly deletedCount: number;
    /** Newest first, capped. Enough to recognise, not a second list view. */
    readonly examples: readonly { ticketNumber: number; status: TicketStatus }[];
}

/**
 * Injectable, matching `sharedJourneyGuard.ts`.
 *
 * Without this the unit tests could only reach the real `database` singleton or
 * `vi.mock` the repo module, and both diverge from the convention this function
 * is modelled on.
 */
export interface TicketTypeUsageDeps {
    readonly tickets?: Pick<TicketsRepo, 'countByType' | 'listByType'>;
}

/**
 * Passed as the last argument so a real call inside a transaction uses that transaction.
 *
 * Separate from `deps` rather than folded into it because the two answer different
 * questions: `deps` swaps the repo out for a fake in a unit test, while the executor picks
 * *which connection* the real repo talks to. Injecting a fake repo makes the executor
 * moot; using the real repo makes it load-bearing.
 */

/**
 * How many examples a refusal carries. Five: enough to recognise the tickets, far
 * short of a second list view.
 */
const EXAMPLE_CAP = 5;

/**
 * How many tickets of this type exist, by status, with a handful of examples.
 *
 * **`deleted` counts.** A deleted ticket keeps its row on purpose — the status
 * union's own comment says the record survives to answer "did this member ever
 * have a verification ticket?" — and a row whose type has no definition can no
 * longer render its own label. Removing a type because the only tickets holding it
 * are deleted would make exactly the history the table exists for unreadable.
 */
export async function ticketTypeUsage(
    guildId: string,
    type: string,
    deps?: TicketTypeUsageDeps,
    executor?: TicketsExecutor
): Promise<TicketTypeUsage> {
    const tickets = deps?.tickets ?? ticketsRepo;

    /*
     * Sequential rather than `Promise.all`, and the executor threaded through both.
     *
     * The caller that matters is `deleteTicketType`, which runs this *inside*
     * `mutateConfig`'s transaction so the count and the removal cannot straddle a ticket
     * being opened. Kysely's sqlite dialect holds one mutexed connection, so these reads
     * must use that transaction or they deadlock against it — and for the same reason they
     * must not overlap, since two concurrent reads would contend for the single connection
     * the transaction is holding. Awaiting in turn costs one extra round trip on a path an
     * operator reaches only when deleting a type.
     */
    const counts = await tickets.countByType(guildId, type, executor);
    const examples = await tickets.listByType(guildId, type, EXAMPLE_CAP, executor);

    const countFor = (status: TicketStatus): number =>
        counts.find((row) => row.status === status)?.count ?? 0;

    return {
        openCount: countFor('open'),
        closedCount: countFor('closed'),
        deletedCount: countFor('deleted'),
        examples: examples.map((ticket) => ({ ticketNumber: ticket.ticketNumber, status: ticket.status })),
    };
}

/** Whether any ticket at all holds the type. The delete gate reads this, not the individual counts. */
export function ticketTypeIsHeld(usage: TicketTypeUsage): boolean {
    return usage.openCount + usage.closedCount + usage.deletedCount > 0;
}

/**
 * The refusal shown when tickets still hold a type.
 *
 * **Counts by status plus example numbers**, because unlike a journey a ticket has
 * no name — `#0042` is what an operator finds it by. A guild can have thousands of
 * one type, so `sharedJourneyRefusal`'s name-every-one shape is honoured by giving
 * both: the counts are the size of the problem, the examples are the handle, and
 * the type-filtered ticket list is where the full set lives.
 *
 * The deleted count gets its own sentence. Refusing a delete because the only
 * holders are *deleted* tickets reads as a bug unless the copy says why, and the
 * why is that a deleted row still has to render its own label.
 */
export function ticketTypeInUseRefusal(input: {
    readonly label: string;
    readonly type: string;
    readonly usage: TicketTypeUsage;
}): string {
    const { label, type, usage } = input;

    // Loud rather than a sentence that reads "…still on the books:  and undefined."
    // Unreachable through `deleteTicketType`, which gates on `ticketTypeIsHeld` — but
    // this is exported, and a second caller building a refusal for a type nothing holds
    // has made a mistake worth hearing about rather than rendering.
    if (!ticketTypeIsHeld(usage)) {
        throw new Error(`Refusal requested for ticket type "${type}", which no ticket holds`);
    }

    const parts: string[] = [];
    if (usage.openCount > 0) parts.push(`${usage.openCount} open`);
    if (usage.closedCount > 0) parts.push(`${usage.closedCount} closed`);
    if (usage.deletedCount > 0) parts.push(`${usage.deletedCount} deleted`);

    const held = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    const examples = usage.examples
        .map((example) => `#${example.ticketNumber.toString().padStart(4, '0')}`)
        .join(', ');

    const sentences = [
        `Deleting **${label}** (\`${type}\`) would orphan tickets that are still on the books: ${held}.`,
    ];

    if (examples) {
        sentences.push(`For instance ${examples}.`);
    }

    if (usage.deletedCount > 0) {
        sentences.push(
            'Deleted tickets count — their rows stick around so the history stays readable, and a row whose type is gone cannot even say what it was.'
        );
    }

    sentences.push('Retype them or let them age out first; this one is not going quietly.');

    return sentences.join(' ');
}
