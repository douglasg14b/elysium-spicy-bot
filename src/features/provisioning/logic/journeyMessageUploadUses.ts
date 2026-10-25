import type { JourneyMessageUploadUse } from '../../../features-system/guild-uploads';
import { messageUploadPlaces } from '../../../shared/discordMessage';
import { journeysRepo } from '../data/journeysRepo';

/**
 * Every use this guild's journeys make of its uploads: one per place a declared message
 * resource shows one, posted or not — a declaration is what install posts, so deleting a
 * picture it shows would break the next install. A picture shown twice is two uses.
 *
 * Read from the journeys alone, and never inside a transaction — SQLite has one connection.
 * `listByGuildId` validates every journey, so one malformed row fails the whole list, the
 * cost `docs/plans/uploads-page.md` already accepted for flows. Only this guild's journeys
 * are read, so another server's message naming the same upload id is not a use here.
 *
 * Registered with guild-uploads by `initProvisioning`.
 */
export async function journeyMessageUploadUses(guildId: string): Promise<readonly JourneyMessageUploadUse[]> {
    const journeys = await journeysRepo.listByGuildId(guildId);

    return journeys.flatMap((journey) =>
        journey.resources.flatMap((resource) =>
            resource.kind === 'message'
                ? messageUploadPlaces(resource.message).map(
                      (place): JourneyMessageUploadUse => ({
                          kind: 'journeyMessage',
                          uploadId: place.uploadId,
                          journeyKey: journey.journeyKey,
                          journeyName: journey.name,
                          resourceKey: resource.key,
                          messageName: resource.defaultName,
                          where: place.where,
                      })
                  )
                : []
        )
    );
}
