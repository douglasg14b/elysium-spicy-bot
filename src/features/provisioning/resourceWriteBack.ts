import type { Guild } from 'discord.js';

/**
 * What an install writes its new ids into.
 *
 * Provisioning knows that *something* consumes resource keys and needs the snowflakes
 * once they exist. It deliberately does not know that the something is flows: it is a
 * base capability, like ticketing, and importing a consumer would invert the
 * dependency permanently for the sake of one call.
 *
 * So the consumer registers itself at wiring time. Provisioning calls whatever is
 * registered and reports the result; with nothing registered, an install still
 * succeeds and simply writes nothing back — which is the correct behaviour for a
 * deployment that uses provisioning without flows.
 */
export interface ResourceWriteBackResult {
    readonly updatedFlowIds: readonly string[];
    readonly writtenCount: number;
    readonly unresolved: readonly { readonly resourceKey: string }[];
    /**
     * Set when the write-back threw and nothing could be written.
     *
     * Distinguishes "there was nothing to write" from "writing failed", which the
     * counts alone cannot: both are zero. Without it a thrown write-back renders as a
     * clean install while every node that picked a resource still holds an empty id —
     * the flow then fails at run time, far from the cause.
     *
     * Optional rather than a discriminant, so the common success path stays the plain
     * shape every caller already reads.
     */
    readonly failed?: true;
}

export type ResourceWriteBack = (
    guild: Guild,
    journeyKey: string
) => Promise<ResourceWriteBackResult>;

const EMPTY: ResourceWriteBackResult = {
    updatedFlowIds: [],
    writtenCount: 0,
    unresolved: [],
};

let registered: ResourceWriteBack | undefined;

/**
 * Register the write-back a successful install should run.
 *
 * Called once during feature init. Replacing an existing registration is allowed and
 * is what tests do; production registers exactly one.
 */
export function registerResourceWriteBack(writeBack: ResourceWriteBack): void {
    registered = writeBack;
}

/** Test seam. Not used in production code. */
export function clearResourceWriteBack(): void {
    registered = undefined;
}

/**
 * Run whatever is registered.
 *
 * A failure here must not fail the install: the guild has already been mutated and
 * those channels are real, so throwing would report a successful install as a failed
 * one and invite a re-run of work that already happened.
 *
 * But it must not vanish either. It is returned as `failed` rather than only logged,
 * because the counts cannot express it — a thrown write-back and a journey nothing
 * references both produce zeroes, and the caller would otherwise tell the operator the
 * install was clean while their nodes still hold empty ids.
 */
export async function runResourceWriteBack(
    guild: Guild,
    journeyKey: string
): Promise<ResourceWriteBackResult> {
    if (!registered) return EMPTY;

    try {
        return await registered(guild, journeyKey);
    } catch (error) {
        console.error('[provisioning] Resource write-back failed:', error);
        return { ...EMPTY, failed: true };
    }
}
