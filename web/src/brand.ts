/**
 * Single source of truth for BrattyBot branding in the dashboard.
 *
 * The displayed name and logo follow the bot account we are actually connected to
 * (see `GET /api/bot`), so a dashboard pointed at the dev application brands itself
 * as such. These constants are the fallback used before the gateway reports in, and
 * the wordmark splitting rule applied to whatever name it reports.
 */

import type { BotFlavour } from './api/types';

/** Shown until `GET /api/bot` answers — and if it never does. */
export const FALLBACK_BOT_NAME = 'BrattyBot';

/**
 * Logos live in `web/public` and are served at the site root. Bundling both means the
 * correct one renders immediately on identity resolution, with no CDN round-trip.
 */
const LOGO_BY_FLAVOUR: Record<BotFlavour, string> = {
    production: '/brattybot-logo.png',
    development: '/brattybot-dev-logo.png',
};

/** Production artwork is the fallback: the common case, and the safer thing to show. */
export function brandLogoUrl(flavour: BotFlavour | null): string {
    return flavour ? LOGO_BY_FLAVOUR[flavour] : LOGO_BY_FLAVOUR.production;
}

/**
 * The wordmark is two-tone: everything up to and including "Bot" in the default
 * colour, with "Bot" itself accented. Splitting on the last "Bot" keeps that working
 * for the suffixed dev name — "Bratty|Bot| Dev" — and degrades to an unaccented name
 * for anything that does not contain it.
 */
interface WordmarkParts {
    before: string;
    accent: string;
    after: string;
}

export function splitWordmark(name: string): WordmarkParts {
    const index = name.toLowerCase().lastIndexOf('bot');
    if (index === -1) {
        return { before: name, accent: '', after: '' };
    }
    return {
        before: name.slice(0, index),
        accent: name.slice(index, index + 3),
        after: name.slice(index + 3),
    };
}
