import { warningsRepo } from '../data/warningsRepo';
import type { Warning, WarningActor } from '../data/warningsSchema';
import { normalizeWarningSlug } from './warningSlug';

export type ClearGuildWarningResult =
    | { status: 'cleared'; warning: Warning }
    | { status: 'already-cleared'; warning: Warning }
    | { status: 'not-found' }
    | { status: 'empty-reason' };

/**
 * Release a warning — active or expired — recording who released it and why. The one
 * release path, for `/warn-clear` and the dashboard alike; the reason is required on both.
 */
export async function clearGuildWarning(
    guildId: string,
    slug: string,
    clearedBy: WarningActor,
    reason: string,
    now: Date = new Date()
): Promise<ClearGuildWarningResult> {
    const normalizedSlug = normalizeWarningSlug(slug);
    if (!normalizedSlug) {
        return { status: 'not-found' };
    }

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
        return { status: 'empty-reason' };
    }

    const updated = await warningsRepo.softClear(guildId, normalizedSlug, clearedBy, trimmedReason, now.toISOString());
    const warning = await warningsRepo.getByGuildAndSlug(guildId, normalizedSlug);

    if (!warning) {
        return { status: 'not-found' };
    }

    return updated ? { status: 'cleared', warning } : { status: 'already-cleared', warning };
}
