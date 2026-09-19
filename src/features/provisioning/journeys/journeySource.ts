import { journeysRepo, toDeclarationFromRow } from '../data/journeysRepo';
import type { JourneyDeclaration } from '../logic/resourceDeclaration';

/**
 * Where a journey comes from: the `journeys` table, scoped to a guild.
 *
 * This replaces the in-memory registry that 5A shipped with. The registry made
 * journeys a *startup* fact — a `Map` populated by `initProvisioning`, which meant
 * the only way to add one was to edit TypeScript and redeploy. That satisfied the
 * weak neutrality property (the engine holds no opinion about which journey ships)
 * while failing the one that matters: an operator can create a journey.
 *
 * Guild-scoped on every call, unlike the registry it replaces. A journey belongs to
 * the server whose channels it describes, and a global lookup keyed only on
 * `journeyKey` would let one guild's install read another's declaration — which the
 * per-guild unique index exists to make impossible.
 */
export async function getJourney(
    guildId: string,
    journeyKey: string
): Promise<JourneyDeclaration | undefined> {
    const row = await journeysRepo.getByKey(guildId, journeyKey);
    return row ? toDeclarationFromRow(row) : undefined;
}

export async function listJourneys(guildId: string): Promise<readonly JourneyDeclaration[]> {
    const rows = await journeysRepo.listByGuildId(guildId);
    return rows.map(toDeclarationFromRow);
}
