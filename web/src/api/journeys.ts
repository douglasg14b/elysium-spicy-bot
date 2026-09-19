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

/**
 * What one flow declares.
 *
 * A flow's journey is implicit — keyed on the flow's own id — so the builder never
 * has to name one or know whether it exists yet. An empty list is the normal state.
 */
export function getFlowResources(
    guildId: string,
    flowId: string
): Promise<ResourceDeclaration[]> {
    return api
        .get<{ resources: ResourceDeclaration[] }>(
            `/api/guilds/${guildId}/flows/${flowId}/resources`
        )
        .then((res) => res.resources);
}

/** Replace what a flow declares. An empty list removes its journey entirely. */
export function saveFlowResources(
    guildId: string,
    flowId: string,
    resources: ResourceDeclaration[]
): Promise<ResourceDeclaration[]> {
    return api
        .put<{ resources: ResourceDeclaration[] }>(
            `/api/guilds/${guildId}/flows/${flowId}/resources`,
            { resources }
        )
        .then((res) => res.resources);
}
