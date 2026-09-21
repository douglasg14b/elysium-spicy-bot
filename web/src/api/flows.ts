/** Flow-builder API helpers. Same style as `config.ts` — pages stay URL-free. */

import { api } from './client';
import type {
    DeployResult,
    Flow,
    FlowGraph,
    FlowSummary,
    GuildRole,
    InstallPlan,
    InstallResult,
    NodeDescriptor,
    PublishedFlowState,
    UndeployedButtonMessage,
    UnpublishedResource,
} from './types';

/** The node registry — what the palette can offer. Not guild-scoped. */
export function getNodeTypes(): Promise<NodeDescriptor[]> {
    return api.get<{ nodes: NodeDescriptor[] }>('/api/nodes').then((res) => res.nodes);
}

/** Guild roles, for the role pickers. */
export function getGuildRoles(guildId: string): Promise<GuildRole[]> {
    return api
        .get<{ roles: GuildRole[] }>(`/api/guilds/${guildId}/roles`)
        .then((res) => res.roles);
}

export function listFlows(guildId: string): Promise<FlowSummary[]> {
    return api
        .get<{ flows: FlowSummary[] }>(`/api/guilds/${guildId}/flows`)
        .then((res) => res.flows);
}

export function getFlow(guildId: string, flowId: string): Promise<Flow> {
    return api.get<Flow>(`/api/guilds/${guildId}/flows/${flowId}`);
}

export function createFlow(guildId: string, name: string, graph?: FlowGraph): Promise<Flow> {
    return api.post<Flow>(`/api/guilds/${guildId}/flows`, graph ? { name, graph } : { name });
}

/** Partial update — send only what changed. A bad graph comes back as a 400 `ApiError`. */
export function updateFlow(
    guildId: string,
    flowId: string,
    patch: { name?: string; enabled?: boolean; graph?: FlowGraph }
): Promise<Flow> {
    return api.put<Flow>(`/api/guilds/${guildId}/flows/${flowId}`, patch);
}

export function deleteFlow(guildId: string, flowId: string): Promise<void> {
    return api.delete<void>(`/api/guilds/${guildId}/flows/${flowId}`);
}

/**
 * Posts the flow's trigger buttons into the channels their nodes name.
 *
 * No channel argument: the destination is authoring data on each button trigger, so
 * one flow can open buttons in several channels at once.
 */
export function deployFlow(guildId: string, flowId: string): Promise<DeployResult> {
    return api.post<DeployResult>(`/api/guilds/${guildId}/flows/${flowId}/deploy`, {});
}

/**
 * What installing this flow's declared resources would do. Changes nothing.
 *
 * A 404 means the flow declares nothing to install; a 409 means the journey keyed on
 * this flow id belongs to a different flow, or declares something that cannot be
 * installed as shared server structure.
 */
export function getInstallPlan(guildId: string, flowId: string): Promise<InstallPlan> {
    return api.get<InstallPlan>(`/api/guilds/${guildId}/flows/${flowId}/install-plan`);
}

/**
 * Create the channels and roles this flow declares, and wire the new ids into the
 * nodes that picked them.
 *
 * Sends no plan: the server rebuilds and re-checks its own, so a plan that stopped
 * being applicable comes back as a 409 carrying the new one rather than being applied
 * on the strength of a stale approval.
 */
export function installFlow(guildId: string, flowId: string): Promise<InstallResult> {
    return api.post<InstallResult>(`/api/guilds/${guildId}/flows/${flowId}/install`, {});
}

/**
 * What this flow has live in the guild right now.
 *
 * The delete dialog asks before it offers to delete anything, because deleting a flow
 * deliberately leaves all of it behind.
 */
export function getPublishedState(guildId: string, flowId: string): Promise<PublishedFlowState> {
    return api.get<PublishedFlowState>(`/api/guilds/${guildId}/flows/${flowId}/published`);
}

/** Deletes the messages carrying this flow's buttons. Safe after the flow is gone. */
export function undeployFlow(
    guildId: string,
    flowId: string
): Promise<{ results: UndeployedButtonMessage[] }> {
    return api.post<{ results: UndeployedButtonMessage[] }>(
        `/api/guilds/${guildId}/flows/${flowId}/undeploy`,
        {}
    );
}

/** Destroys the channels and roles this flow's journey created. Irreversible. */
export function unpublishFlow(
    guildId: string,
    flowId: string
): Promise<{ results: UnpublishedResource[] }> {
    return api.post<{ results: UnpublishedResource[] }>(
        `/api/guilds/${guildId}/flows/${flowId}/unpublish`,
        {}
    );
}
