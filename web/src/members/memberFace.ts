/**
 * How a person is drawn in a table row — picture, name, handle — shared by every page that
 * lists people, so the leaderboard and the warnings list look the same.
 */

import type { MemberName } from '@brattybot/web-sdk';
import { memberNameLabel } from './memberNames';

/** What a row needs to draw a person, with absence already resolved. */
export interface MemberFace {
    /** Always printable: a display name, or the id when nobody can name them. */
    readonly name: string;
    /** The handle, when one is known. Null otherwise — never a fabricated `@id`. */
    readonly handle: string | null;
    /** Null means "render the monogram", not "broken image". */
    readonly avatarUrl: string | null;
    /** Two letters for the avatar fallback. */
    readonly monogram: string;
}

/**
 * Two letters for an avatar with no image, matching `DashboardLayout`'s monogram rule.
 *
 * Duplicated deliberately rather than exported from the layout: that copy takes a guild or
 * user name and this one has to survive a raw snowflake, and coupling a nav component to a
 * table row to share five lines is the worse trade.
 */
export function monogramOf(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase() || '??';
}

/** A person as the bot remembers them: the name they go by now, their handle, the avatar it kept. */
export function rememberedFace(remembered: MemberName): MemberFace {
    const name = memberNameLabel(remembered);
    return {
        name,
        handle: remembered.username || null,
        avatarUrl: remembered.avatarUrl,
        monogram: monogramOf(name),
    };
}

/** Somebody the bot has no memory of: whatever name was recorded, else the id, and no picture. */
export function unrememberedFace(name: string): MemberFace {
    return { name, handle: null, avatarUrl: null, monogram: monogramOf(name) };
}
