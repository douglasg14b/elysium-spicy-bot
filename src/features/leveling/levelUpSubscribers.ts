import type { Guild } from 'discord.js';

/**
 * What a level-up notifies, beyond the announcement.
 *
 * Leveling knows that *something* may want to react to a member crossing a level. It
 * deliberately does not know that the something is flows: leveling is a base capability,
 * like provisioning, and importing a consumer would invert the dependency permanently
 * for the sake of one call.
 *
 * So the consumer registers itself at wiring time, exactly as provisioning's
 * `registerResourceWriteBack` does. Leveling calls whatever is registered; with nothing
 * registered a level-up still announces and simply notifies nobody, which is the correct
 * behaviour for a deployment that runs leveling without flows.
 */
export interface LevelUpEvent {
    readonly guild: Guild;
    readonly userId: string;
    /** The level just reached. One event per level crossed, not per XP grant. */
    readonly level: number;
    readonly totalXp: number;
}

export type LevelUpSubscriber = (event: LevelUpEvent) => Promise<void>;

let registered: LevelUpSubscriber | undefined;

/**
 * Register the subscriber a level-up should notify.
 *
 * Called once during feature init. Replacing an existing registration is allowed and is
 * what tests do; production registers exactly one.
 */
export function registerLevelUpSubscriber(subscriber: LevelUpSubscriber): void {
    registered = subscriber;
}

/** Test seam. Not used in production code. */
export function clearLevelUpSubscriber(): void {
    registered = undefined;
}

/**
 * Notify whatever is registered.
 *
 * A failure here must not fail the grant: the XP is already persisted and the
 * announcement has already gone out, so throwing would unwind neither and would strand
 * the caller mid-loop over levels it has already awarded.
 *
 * Nor is the result reported back. Unlike the provisioning write-back — whose caller
 * tells an operator whether their install was clean — nothing is waiting on this answer:
 * a level-up has no operator watching it and no summary to be wrong about. Logging is
 * the whole contract.
 */
export async function notifyLevelUp(event: LevelUpEvent): Promise<void> {
    if (!registered) return;

    try {
        await registered(event);
    } catch (error) {
        console.error(
            `[leveling] Level-up subscriber failed for ${event.userId} at level ${event.level}:`,
            error
        );
    }
}
