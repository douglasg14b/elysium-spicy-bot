import { Events } from 'discord.js';
import { afterAll, describe, expect, it } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { isBackfillPending } from '../backfillState';
import { initActivityTracking } from '../initActivityTracking';

/**
 * The ordering the flow scheduler depends on: quiet-window runs are held from wiring, not
 * from activity's own ClientReady hook, so the scheduler's startup sweep — run from a
 * ClientReady listener of its own — can never see "not pending" ahead of the backfill.
 */

afterAll(() => {
    DISCORD_CLIENT.removeAllListeners(Events.MessageCreate);
    DISCORD_CLIENT.removeAllListeners(Events.MessageReactionAdd);
    DISCORD_CLIENT.removeAllListeners(Events.ClientReady);
});

describe('initActivityTracking', () => {
    it('holds quiet-window runs before the client is ready, and leaves the session to ClientReady', () => {
        expect(isBackfillPending()).toBe(false);

        initActivityTracking();

        expect(isBackfillPending()).toBe(true);
        expect(DISCORD_CLIENT.listenerCount(Events.ClientReady)).toBe(1);
    });
});
