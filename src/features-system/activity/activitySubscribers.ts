import type { Guild, Message } from 'discord.js';

/**
 * What a recorded activity event notifies.
 *
 * Activity is a base capability: it records who was active where whether or not any
 * feature cares. Leveling consumes it to award XP, but activity never imports leveling —
 * the consumer registers itself at wiring time, the same single-registration shape as
 * `levelUpSubscribers`. With nothing registered, activity is still recorded.
 *
 * Every event carries the id of the row already written, so a subscriber can link its own
 * record to it. A failed write notifies nobody: there is no event to link to, and the
 * subscriber contract has no null arm for it.
 *
 * What a subscriber may rely on: every event is in a guild, and its member is not a bot or
 * a webhook; a message event is never a system message. Anything narrower — such as
 * leveling's "no XP for `/`-prefixed messages" — is the subscriber's own rule.
 */
interface ActivityEventBase {
    readonly activityEventId: number;
    readonly guild: Guild;
    readonly userId: string;
    /** For a reaction, the channel of the message reacted to. */
    readonly channelId: string;
}

export interface MessageActivityEvent extends ActivityEventBase {
    readonly kind: 'message';
    readonly message: Message<true>;
}

/** The member is the reactor, not the author of the message reacted to. */
export interface ReactionActivityEvent extends ActivityEventBase {
    readonly kind: 'reaction';
}

export type RecordedActivityEvent = MessageActivityEvent | ReactionActivityEvent;

export type ActivitySubscriber = (event: RecordedActivityEvent) => Promise<void>;

let registered: ActivitySubscriber | undefined;

/**
 * Register the subscriber a recorded activity event should notify.
 *
 * Called once during feature init. Replacing an existing registration is allowed and is
 * what tests do; production registers exactly one.
 */
export function registerActivitySubscriber(subscriber: ActivitySubscriber): void {
    registered = subscriber;
}

/** Test seam. Not used in production code. */
export function clearActivitySubscriber(): void {
    registered = undefined;
}

/**
 * Notify whatever is registered.
 *
 * A subscriber failure is logged and never unwinds the recorded event: the activity row is
 * already written, and whether the member earned XP for it is not activity's concern.
 */
export async function notifyActivity(event: RecordedActivityEvent): Promise<void> {
    if (!registered) return;

    try {
        await registered(event);
    } catch (error) {
        console.error(
            `[activity] Subscriber failed for ${event.kind} event ${event.activityEventId} (user ${event.userId}):`,
            error
        );
    }
}
