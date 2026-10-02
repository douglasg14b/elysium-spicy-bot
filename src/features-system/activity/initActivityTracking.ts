import { Events, type Client } from 'discord.js';
import { DISCORD_CLIENT } from '../../discordClient';
import { recordMessageActivity, recordReactionActivity } from './activityRecorder';
import { markBackfillPending } from './backfillState';
import { startRecorderSession } from './recorderSession';

let activityTrackingInitialized = false;

/**
 * Attach the gateway listeners that record member activity, and the startup backfill.
 *
 * These are the only `MessageCreate`/`MessageReactionAdd` listeners leveling depends on:
 * leveling receives activity through `registerActivitySubscriber`, not from Discord.
 * Flows keeps its own separate reaction listener.
 *
 * Recording starts as soon as the client connects. Once it is ready, the recorder session
 * begins and backfills, in the background, the messages missed while the bot was down.
 */
export function initActivityTracking(): void {
    if (activityTrackingInitialized) {
        return;
    }

    activityTrackingInitialized = true;

    // Pending from wiring rather than from the ready hook, so quiet-window runs are held
    // before *any* ClientReady listener runs — the flow scheduler sweeps from its own, and
    // must never see a window of "not pending" ahead of the backfill, whatever order the
    // listeners were registered in. `startRecorderSession` always clears it.
    markBackfillPending();

    DISCORD_CLIENT.on(Events.MessageCreate, (message) => {
        void recordMessageActivity(message).catch((error) => {
            console.error('[activity] Error handling message create:', error);
        });
    });

    DISCORD_CLIENT.on(Events.MessageReactionAdd, (reaction, user) => {
        void recordReactionActivity(reaction, user).catch((error) => {
            console.error('[activity] Error handling reaction add:', error);
        });
    });

    // A client already ready would never emit ClientReady again, leaving the flag above up
    // for the life of the process and every quiet-window run held with it.
    if (DISCORD_CLIENT.isReady()) {
        beginRecorderSession(DISCORD_CLIENT);
    } else {
        DISCORD_CLIENT.once(Events.ClientReady, beginRecorderSession);
    }
}

function beginRecorderSession(readyClient: Client<true>): void {
    void startRecorderSession(readyClient).catch((error: unknown) => {
        console.error('[activity] Recorder session failed to start:', error);
    });
}
