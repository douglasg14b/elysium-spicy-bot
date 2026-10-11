import type { TicketTypeSettings } from '../tickets/data/ticketingSchema';

/**
 * How provisioning reads and creates a guild's ticket types, without importing tickets.
 *
 * A journey may declare a ticket type (`ResourceKind` `ticketType`), and install has to
 * know whether one of that key exists and make it if not. Ticket types belong to the
 * ticket feature, which already imports provisioning — so a runtime import the other way
 * would be a cycle, and would make provisioning a consumer of the feature it serves. The
 * same answer as `resourceWriteBack.ts`: provisioning defines the hook, and tickets
 * register an implementation at wiring time (`registerTicketTypeProvisioning`).
 *
 * Unlike the write-back, a missing provider is **not** a quiet no-op. An install that
 * declares a ticket type and cannot read ticket types has no honest plan to show, so it
 * throws, naming the hook ({@link requireTicketTypeProvider}).
 */

/** What the guild's ticket settings hold, as install needs to know it. */
export type TicketTypeReading =
    /** No ticket config at all: the one case where creating a type cannot succeed. */
    | { readonly status: 'no-config'; readonly blockedReason: string }
    | {
          readonly status: 'ok';
          /** Whether the ticket system is set up enough for a ticket to open. */
          readonly ready: boolean;
          /** What to say on each ticket type item when `ready` is false; null otherwise. */
          readonly notReadyNote: string | null;
          /** The guild's ticket types, by key. */
          readonly types: ReadonlyMap<string, { readonly label: string }>;
      };

/**
 * What creating a type came to.
 *
 * `exists` is the race lost gracefully: a type of this key appeared between the plan and
 * the apply — another journey, the dashboard, the Discord modal — and it is used as it
 * stands, never rewritten. `refused` carries the ticket feature's own sentence.
 */
export type TicketTypeCreateOutcome =
    | { readonly outcome: 'created' }
    | { readonly outcome: 'exists'; readonly label: string }
    | { readonly outcome: 'refused'; readonly message: string };

export interface TicketTypeProvider {
    read(guildId: string): Promise<TicketTypeReading>;
    /**
     * Create the type only if no type of this key exists. **Never replaces one**: a type
     * already there, however it differs from these settings, comes back as `exists`.
     */
    createIfAbsent(
        guildId: string,
        key: string,
        label: string,
        settings: TicketTypeSettings
    ): Promise<TicketTypeCreateOutcome>;
}

let registered: TicketTypeProvider | undefined;

/**
 * Register the ticket feature's provider. Called once at wiring time by every boot root
 * (`initTicketsFeature`, and the dashboard harness in `web/e2e/support/bootBot.ts`);
 * replacing an existing registration is allowed, which is what tests do.
 */
export function registerTicketTypeProvider(provider: TicketTypeProvider): void {
    registered = provider;
}

/** Test seam. Not used in production code. */
export function clearTicketTypeProviderForTests(): void {
    registered = undefined;
}

/**
 * The registered provider, or a loud failure.
 *
 * Asked only when a journey actually declares a ticket type, so a deployment without the
 * ticket feature can still install journeys that do not. Reaching here with nothing
 * registered is a wiring fault — a boot root that skipped `registerTicketTypeProvisioning`
 * — and guessing an answer would show an operator a plan nobody could honour.
 */
export function requireTicketTypeProvider(): TicketTypeProvider {
    if (!registered) {
        throw new Error(
            'This journey declares a ticket type, but no ticket type provider is registered. A boot root skipped registerTicketTypeProvisioning() from the tickets feature.'
        );
    }
    return registered;
}
