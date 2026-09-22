/** Journey API helpers. Same style as `flows.ts` — pages stay URL-free. */

import { api } from './client';
import type {
    AttachResult,
    FlowAttachment,
    Journey,
    JourneySummary,
    ResourceDeclaration,
} from './types';

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

/** Which journey this flow installs, or `null` when it is attached to none. */
export function getFlowAttachment(
    guildId: string,
    flowId: string
): Promise<FlowAttachment | null> {
    return api
        .get<{ attachment: FlowAttachment | null }>(
            `/api/guilds/${guildId}/flows/${flowId}/attachment`
        )
        .then((res) => res.attachment);
}

/**
 * Point a flow at an existing journey.
 *
 * A **move**, not an addition: a flow has at most one journey, so attaching one that is
 * already attached detaches it from the old journey in the same statement. The result's
 * `movedFrom` says which one it left.
 */
export function attachFlowToJourney(
    guildId: string,
    flowId: string,
    journeyKey: string
): Promise<AttachResult> {
    return api.post<AttachResult>(`/api/guilds/${guildId}/flows/${flowId}/attach`, {
        journeyKey,
    });
}

/**
 * Detach a flow from its journey.
 *
 * Leaves the journey and anything already installed in the guild alone — detaching is
 * not a teardown, and removing channels is `/unpublish`'s job.
 */
export function detachFlowFromJourney(
    guildId: string,
    flowId: string
): Promise<{ detached: boolean }> {
    return api.post<{ detached: boolean }>(
        `/api/guilds/${guildId}/flows/${flowId}/detach`,
        {}
    );
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
