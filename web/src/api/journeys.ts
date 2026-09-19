/** Journey API helpers. Same style as `flows.ts` — pages stay URL-free. */

import { api } from './client';
import type { Journey, JourneySummary, ResourceDeclaration } from './types';

export function listJourneys(guildId: string): Promise<JourneySummary[]> {
    return api
        .get<{ journeys: JourneySummary[] }>(`/api/guilds/${guildId}/journeys`)
        .then((res) => res.journeys);
}

export function getJourney(guildId: string, journeyKey: string): Promise<Journey> {
    return api.get<Journey>(`/api/guilds/${guildId}/journeys/${journeyKey}`);
}

export function createJourney(
    guildId: string,
    input: {
        journeyKey: string;
        name: string;
        description?: string;
        resources: ResourceDeclaration[];
    }
): Promise<Journey> {
    return api.post<Journey>(`/api/guilds/${guildId}/journeys`, input);
}

/** Partial update — send only what changed. An invalid declaration comes back as a 400. */
export function updateJourney(
    guildId: string,
    journeyKey: string,
    patch: { name?: string; description?: string | null; resources?: ResourceDeclaration[] }
): Promise<Journey> {
    return api.put<Journey>(`/api/guilds/${guildId}/journeys/${journeyKey}`, patch);
}

export function deleteJourney(guildId: string, journeyKey: string): Promise<void> {
    return api.delete<void>(`/api/guilds/${guildId}/journeys/${journeyKey}`);
}
