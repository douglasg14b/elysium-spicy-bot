import type { Guild, Message } from 'discord.js';

/**
 * What a recorded activity event notifies.
 *
 * Activity is a base capability: it records who was active where whether or not any
 * feature cares. Leveling consumes it to award XP, and flows to wake runs waiting on a
 * message and start Message Sent runs, but activity imports neither — each consumer registers itself at wiring
 * time. With nothing registered, activity is still recorded.
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
    /** The channel the thread sits under, when the message was posted in a thread; otherwise null. */
    readonly parentChannelId: string | null;
}

/** The member is the reactor, not the author of the message reacted to. */
export interface ReactionActivityEvent extends ActivityEventBase {
    readonly kind: 'reaction';
}

export type RecordedActivityEvent = MessageActivityEvent | ReactionActivityEvent;

export type ActivitySubscriber = (event: RecordedActivityEvent) => Promise<void>;

const registered: ActivitySubscriber[] = [];

/**
 * Add a subscriber every recorded activity event should notify.
 *
 * Called once per consumer during feature init. Appends: a second consumer never evicts
 * the first, which a single slot would do silently — leveling would stop awarding XP the
 * moment flows registered.
 */
export function registerActivitySubscriber(subscriber: ActivitySubscriber): void {
    registered.push(subscriber);
}

/** Remove every subscriber. Test seam; not used in production code. */
export function clearActivitySubscriber(): void {
    registered.length = 0;
}

/**
 * Notify every subscriber, in parallel, and wait for all of them.
 *
 * Each is isolated from the others: one that throws is logged on its own line and
 * neither stops the rest nor unwinds the recorded event — the activity row is already
 * written, and what a consumer made of it is not activity's concern.
 */
export async function notifyActivity(event: RecordedActivityEvent): Promise<void> {
    // Copied, so a registration made while subscribers are running joins the next event
    // rather than this one.
    const subscribers = [...registered];
    const settled = await Promise.allSettled(subscribers.map(async (subscriber) => subscriber(event)));

    for (const outcome of settled) {
        if (outcome.status === 'rejected') {
            console.error(
                `[activity] Subscriber failed for ${event.kind} event ${event.activityEventId} (user ${event.userId}):`,
                outcome.reason
            );
        }
    }
}
