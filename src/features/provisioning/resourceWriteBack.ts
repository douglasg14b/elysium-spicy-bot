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
 * those channels are real. Reporting an empty result loses the write-back detail, so
 * the error is logged and the caller's "still waiting" line covers what did not land.
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
        return EMPTY;
    }
}
