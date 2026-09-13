/** Flow-builder API helpers. Same style as `config.ts` — pages stay URL-free. */

import { api } from './client';
import type {
    DeployResult,
    Flow,
    FlowGraph,
    FlowSummary,
    GuildRole,
    NodeDescriptor,
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

/** Posts the flow's button-trigger message into a channel. */
export function deployFlow(
    guildId: string,
    flowId: string,
    channelId: string
): Promise<DeployResult> {
    return api.post<DeployResult>(`/api/guilds/${guildId}/flows/${flowId}/deploy`, { channelId });
}
