/** Journey API helpers. Same style as `flows.ts` — pages stay URL-free. */

import { api } from './client';
import type {
    AttachResult,
    FlowAttachment,
    ForgottenOrphan,
    GroupPreview,
    GroupResolution,
    Journey,
    JourneyDrift,
    JourneySummary,
    PublishedFlowState,
    RepairedResource,
    ResourceDeclaration,
    UndeployedButtonMessage,
    UnpublishedResource,
} from './types';

export function listJourneys(guildId: string): Promise<JourneySummary[]> {
    return api
        .get<{ journeys: JourneySummary[] }>(`/api/guilds/${guildId}/journeys`)
        .then((res) => res.journeys);
}

/**
 * Partial update — send only what changed. An invalid declaration comes back as a 400.
 *
 * The flows page uses this for one field: a journey's name, edited in place on the group
 * header. The key is never sent, because it is identity — `resource_bindings` and link
 * rows point at it.
 */
export function updateJourney(
    guildId: string,
    journeyKey: string,
    patch: { name?: string; description?: string | null; resources?: ResourceDeclaration[] }
): Promise<Journey> {
    return api.put<Journey>(`/api/guilds/${guildId}/journeys/${journeyKey}`, patch);
}

/*
 * No `createJourney` or `deleteJourney` here.
 *
 * They existed for the journeys page, which was deleted — a journey is not a thing an
 * operator goes and manages (PRD §5.8). A journey is now created implicitly: by a flow
 * saving resources, or by `groupFlowWith` below when two flows are dragged together. It
 * dies when its last flow leaves rather than by being deleted while flows still install
 * it. The server routes remain and are still tested; nothing in the client needs them.
 *
 * `GET /journeys/:key` *is* used, as `getJourneyResources` below — the group header edits
 * a journey's declarations directly, which is a different thing from managing a journey as
 * an object and does not bring the page back.
 */

/**
 * What grouping `flowId` with `targetFlowId` would do, before anything is written.
 *
 * Called on drop. A 409 means the moving flow's journey is shared and cannot follow it —
 * the message names the other flows.
 */
export function previewFlowGrouping(
    guildId: string,
    flowId: string,
    targetFlowId: string
): Promise<GroupPreview> {
    return api.get<GroupPreview>(
        `/api/guilds/${guildId}/flows/${flowId}/group-preview?target=${encodeURIComponent(targetFlowId)}`
    );
}

/**
 * Commit the drop.
 *
 * `resolution` is required whenever the moving flow declares resources; the server
 * refuses rather than assuming one, because "leave" abandons live Discord objects.
 * `newJourneyKey` is needed only when the target has no journey yet — the client derives
 * it, since it already holds the list needed to make it unique.
 */
export function groupFlowWith(
    guildId: string,
    flowId: string,
    input: {
        targetFlowId: string;
        resolution?: GroupResolution;
        newJourneyKey?: string;
        newJourneyName?: string;
    }
): Promise<{ journeyKey: string; name: string; resourceCount: number }> {
    return api.post(`/api/guilds/${guildId}/flows/${flowId}/group`, input);
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

/**
 * What one **journey** declares.
 *
 * The group header's editor reads this rather than `getFlowResources` through a member
 * flow. The flow route resolves the journey server-side and answers the same list today —
 * but which member it would go through is arbitrary, and that member can leave the group
 * while the dialog is open. Asking the journey asks the thing that actually owns the list.
 *
 * A 404 means no such journey in this guild, including one belonging to another guild,
 * which is deliberately indistinguishable.
 */
export function getJourneyResources(
    guildId: string,
    journeyKey: string
): Promise<ResourceDeclaration[]> {
    return api
        .get<Journey>(`/api/guilds/${guildId}/journeys/${encodeURIComponent(journeyKey)}`)
        .then((journey) => journey.resources);
}

/**
 * What this **journey** has live in the guild right now.
 *
 * The group header's inventory. Scoped to the journey rather than to one of its flows,
 * which is the difference that matters in `buttonMessages`: every attached flow's posted
 * messages are here, because the teardown below takes all of them down.
 *
 * A 404 means no such journey in this guild — including a key belonging to someone
 * else's, which is deliberately indistinguishable.
 */
export function getJourneyPublishedState(
    guildId: string,
    journeyKey: string
): Promise<PublishedFlowState> {
    return api.get<PublishedFlowState>(
        `/api/guilds/${guildId}/journeys/${encodeURIComponent(journeyKey)}/published`
    );
}

/** Deletes the messages carrying the buttons of every flow on this journey. */
export function undeployJourney(
    guildId: string,
    journeyKey: string
): Promise<{ results: UndeployedButtonMessage[] }> {
    return api.post<{ results: UndeployedButtonMessage[] }>(
        `/api/guilds/${guildId}/journeys/${encodeURIComponent(journeyKey)}/undeploy`,
        {}
    );
}

/**
 * Destroys the channels and roles this journey created. Irreversible.
 *
 * Unlike `unpublishFlow`, this is **not** refused when several flows share the journey.
 * That refusal protects flows an operator cannot see from a teardown started on one of
 * their siblings; acting on the journey itself is the case it was pointing them towards.
 */
export function unpublishJourney(
    guildId: string,
    journeyKey: string
): Promise<{ results: UnpublishedResource[] }> {
    return api.post<{ results: UnpublishedResource[] }>(
        `/api/guilds/${guildId}/journeys/${encodeURIComponent(journeyKey)}/unpublish`,
        {}
    );
}

/**
 * What this journey installed that no longer matches what it declares.
 *
 * The third question about a resource, after "does it exist" (the install plan) and
 * "may I delete it" (the published inventory). Orphans ride in the same response
 * because they belong to the same screen, not because they are the same question.
 *
 * Reads the guild rather than the binding table's opinion of it, which is the whole
 * difference between this and the `installState` on the flows list.
 */
export function getJourneyDrift(guildId: string, journeyKey: string): Promise<JourneyDrift> {
    return api.get<JourneyDrift>(
        `/api/guilds/${guildId}/journeys/${encodeURIComponent(journeyKey)}/drift`
    );
}

/**
 * Put the named resources back to what the journey declared.
 *
 * Keys only. The server rebuilds the report itself rather than accepting the one the
 * browser was shown — sending it back would let a client name resources the real
 * comparison never found. A key whose drift has since resolved is simply reported as
 * nothing to do.
 *
 * Reconciles the guild **to** the declaration, never the reverse, and never touches an
 * adopted resource whatever this asks for.
 */
export function repairJourneyDrift(
    guildId: string,
    journeyKey: string,
    resourceKeys: readonly string[]
): Promise<{ results: RepairedResource[] }> {
    return api.post<{ results: RepairedResource[] }>(
        `/api/guilds/${guildId}/journeys/${encodeURIComponent(journeyKey)}/repair`,
        { resourceKeys }
    );
}

/**
 * Drop the leftover record of a resource this journey no longer declares.
 *
 * **Forgets the row; never touches the object.** Deleting a stray channel needs guards
 * the whole-journey teardown already owns, so an operator who wants the object gone
 * uses that or removes it in Discord. The response says whether anything was left
 * behind.
 */
export function forgetJourneyOrphan(
    guildId: string,
    journeyKey: string,
    bindingId: number
): Promise<ForgottenOrphan> {
    return api.post<ForgottenOrphan>(
        `/api/guilds/${guildId}/journeys/${encodeURIComponent(journeyKey)}/orphans/${bindingId}/forget`,
        {}
    );
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
