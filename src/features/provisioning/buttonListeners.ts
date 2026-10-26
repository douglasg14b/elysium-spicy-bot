/**
 * Who listens to a message resource's buttons.
 *
 * Provisioning renders the buttons and flows listens to them, but provisioning may not import
 * flows — so the shape of an answer, and the hook install and drift ask it through, live here,
 * where both can reach them. The same seam as `ticketTypeProvider.ts`: provisioning defines it,
 * flows registers `journeyButtonListeners` at wiring time (`initFlows`), and every boot root
 * that serves the dashboard reaches that registration.
 */

/** One trigger listening to one button of one of a journey's messages. */
export interface ButtonListener {
    /** The message resource's key in the journey. */
    readonly messageKey: string;
    /** One of that message's buttons, by key. */
    readonly buttonKey: string;
    readonly flowId: string;
    readonly flowName: string;
    /** The trigger node naming the button. */
    readonly nodeId: string;
    /** Whether its flow is switched on. An off flow is listed: it still names the button. */
    readonly enabled: boolean;
}

/** Every trigger of one journey's flows naming one of its messages' buttons, live and off. */
export type ButtonListenerReader = (guildId: string, journeyKey: string) => Promise<ButtonListener[]>;

let registered: ButtonListenerReader | undefined;

/**
 * Register the flow engine's reader. Called once at wiring time by every boot root (`initFlows`,
 * and the dashboard harness in `web/e2e/support/bootBot.ts`); replacing an existing registration
 * is allowed, which is what tests do.
 */
export function registerButtonListenerReader(reader: ButtonListenerReader): void {
    registered = reader;
}

/** Test seam. Not used in production code. */
export function clearButtonListenerReaderForTests(): void {
    registered = undefined;
}

/**
 * The registered reader, or a loud failure.
 *
 * Asked only when a journey declares a message with buttons, so a journey without one installs
 * with nothing registered. Reaching here with nothing registered is a wiring fault — a boot root
 * that skipped `initFlows` — and answering "nobody listens" in its place would tell an operator
 * a button is dead when a flow is waiting on it.
 */
export function requireButtonListenerReader(): ButtonListenerReader {
    if (!registered) {
        throw new Error(
            "This journey's messages have buttons, but no button listener reader is registered. A boot root skipped registerButtonListenerReader() from the flow engine."
        );
    }
    return registered;
}
