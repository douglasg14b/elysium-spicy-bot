import { describe, expect, it } from 'vitest';
import {
    DISCORD_RESOURCE_KINDS as BROWSER_DISCORD_RESOURCE_KINDS,
    RESOURCE_KINDS as BROWSER_RESOURCE_KINDS,
    isDiscordResourceKind as browserIsDiscordResourceKind,
} from '../../../../../web/src/api/types';
import { DISCORD_RESOURCE_KINDS, RESOURCE_KINDS, isDiscordResourceKind } from '../resourceDeclaration';

/**
 * The drift gate between the server's resource kinds and the browser's copy of them.
 *
 * The browser's `ResourceKind` had no gate at all while it was three channel-ish kinds
 * that rarely changed. A fourth kind — a ticket type, which is not a Discord object — makes
 * the split as important as the list: a browser that thought a ticket type had a parent or
 * a snowflake would offer controls the server refuses on save.
 */
const REMEDY =
    'Reconcile the kind arrays in `web/src/api/types.ts` with `src/features/provisioning/logic/resourceDeclaration.ts`.';

describe('resource kind mirror drift', () => {
    it('lists the same kinds, in the same order', () => {
        expect([...BROWSER_RESOURCE_KINDS], REMEDY).toEqual([...RESOURCE_KINDS]);
    });

    it('splits the same kinds off as Discord objects', () => {
        expect([...BROWSER_DISCORD_RESOURCE_KINDS], REMEDY).toEqual([...DISCORD_RESOURCE_KINDS]);
    });

    it.each(RESOURCE_KINDS)('agrees whether a %s is a Discord object', (kind) => {
        expect(browserIsDiscordResourceKind(kind), REMEDY).toBe(isDiscordResourceKind(kind));
    });

    it('does not count a ticket type as a Discord object', () => {
        expect(isDiscordResourceKind('ticketType')).toBe(false);
    });
});
