/**
 * What uses a server's uploads, without importing whatever uses them.
 *
 * Deleting an upload has to know whether anything still shows it, and only the features
 * that hold pictures know where they sit — flows in its graphs and drafts, provisioning in
 * its journeys' message resources. This module imports no feature (flows and provisioning both read it),
 * so it keeps a list each of them adds a reader to at wiring time, as activity's
 * `registerActivitySubscriber` does: a use is a use whoever reports it.
 *
 * With nothing registered, asking is a **loud failure**, never "no uses": an empty answer
 * would let a delete remove pictures that are in use. That catches a boot root that wired
 * none; it cannot tell that one of several readers is missing.
 */

/**
 * One place a server's upload is shown: a flow node's message (`flow`), or a message a
 * journey declares as a resource (`journeyMessage`). Discriminated on `kind`, as the wire's
 * `UploadUse` is.
 */
export type UploadUse = FlowUploadUse | JourneyMessageUploadUse;

/** An upload shown by a message in a flow's node — saved, or in somebody's draft. */
export interface FlowUploadUse {
    readonly kind: 'flow';
    readonly uploadId: string;
    readonly flowId: string;
    readonly flowName: string;
    readonly nodeId: string;
    /** The block holding the picture, as the palette names it: `Post Embed`. */
    readonly blockLabel: string;
    /** The part showing it, as the message editor names it: `embed 1 thumbnail`. */
    readonly where: string;
    /** Set when the use is in someone's unsaved draft, not the saved flow: whose draft. */
    readonly draftAuthorId?: string;
}

/** An upload shown by a message resource a journey declares, posted or not. */
export interface JourneyMessageUploadUse {
    readonly kind: 'journeyMessage';
    readonly uploadId: string;
    readonly journeyKey: string;
    readonly journeyName: string;
    readonly resourceKey: string;
    /** The message's name, as the Resources panel shows it: `Rules panel`. */
    readonly messageName: string;
    /** The part showing it, as the message editor names it: `embed 1 image`. */
    readonly where: string;
}

/** Every use one feature holds of a guild's uploads. */
export type UploadUsageReader = (guildId: string) => Promise<readonly UploadUse[]>;

const readers: UploadUsageReader[] = [];

/**
 * Register a feature's reader. Called once at wiring time by every boot root that serves the
 * dashboard (`initProvisioning` and `initFlows`, and the dashboard harness in
 * `web/e2e/support/bootBot.ts`).
 */
export function registerUploadUsageReader(reader: UploadUsageReader): void {
    readers.push(reader);
}

/** Test seam. Not used in production code. */
export function clearUploadUsageReadersForTests(): void {
    readers.length = 0;
}

/**
 * Every use of this guild's uploads, from every registered reader, joined in registration
 * order. The readers run at once, outside any transaction — safe on SQLite's one connection
 * only because no reader opens one.
 *
 * @throws when no reader is registered at all — a boot root that skipped the wiring. Guessing
 * "no uses" would let a delete remove a picture a flow still shows.
 *
 * **Only "none at all" is caught here.** A boot root that registers one of the two readers and
 * forgets the other passes silently, answering "no uses" for that feature's pictures. That
 * half is held by `provisioningWiring.test.ts`, which reads each boot root for both.
 */
export async function uploadUsesForGuild(guildId: string): Promise<readonly UploadUse[]> {
    if (readers.length === 0) {
        throw new Error(
            'Asked what uses this server\'s uploads, but no upload usage reader is registered at all. A boot root skipped both initProvisioning() and flows\' reader (initFlows(), or registerUploadUsageReader(flowUploadUses)). This only notices none at all: one reader without the other is not caught here.'
        );
    }
    const found = await Promise.all(readers.map((reader) => reader(guildId)));
    return found.flat();
}
