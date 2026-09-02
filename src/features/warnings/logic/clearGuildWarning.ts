import { warningsRepo } from '../data/warningsRepo';
import type { Warning } from '../data/warningsSchema';

export type ClearGuildWarningResult =
    | { status: 'cleared'; warning: Warning }
    | { status: 'already-cleared'; warning: Warning }
    | { status: 'not-found' };

export async function clearGuildWarning(
    guildId: string,
    slug: string,
    clearedById: string,
    now: Date = new Date()
): Promise<ClearGuildWarningResult> {
    const normalizedSlug = slug.trim().toLowerCase();
    if (!normalizedSlug) {
        return { status: 'not-found' };
    }

    const updated = await warningsRepo.softClear(guildId, normalizedSlug, clearedById, now.toISOString());
    const warning = await warningsRepo.getByGuildAndSlug(guildId, normalizedSlug);

    if (updated) {
        if (!warning) {
            return { status: 'not-found' };
        }

        return { status: 'cleared', warning };
    }

    if (!warning) {
        return { status: 'not-found' };
    }

    return { status: 'already-cleared', warning };
}
