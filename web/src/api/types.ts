/** Shapes returned by the SpicyBot API. Kept in sync with `src/web/api/*` by hand. */

export interface AuthUser {
    id: string;
    username: string;
    avatar: string | null;
}

export interface Guild {
    id: string;
    name: string;
    iconURL: string | null;
    memberCount: number;
}

export interface GuildChannel {
    id: string;
    name: string;
}

export interface WarningsConfig {
    modChannelId: string | null;
    modChannelName: string | null;
}

/** A role as returned by `GET /api/guilds/:guildId/roles`. */
export interface GuildRole {
    id: string;
    name: string;
    /** Discord role colour as a 24-bit int. `0` means "no colour" (inherit). */
    color: number;
    position: number;
}

/* ------------------------------------------------------------------ *
 * Flows
 * ------------------------------------------------------------------ */

export type NodeKind = 'trigger' | 'condition' | 'action';

/** An available node type from the engine's registry (`GET /api/nodes`). */
export interface NodeTypeInfo {
    type: string;
    kind: NodeKind;
    label: string;
}

export interface FlowNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
}

export interface FlowEdge {
    id: string;
    source: string;
    sourceHandle?: string;
    target: string;
    targetHandle?: string;
}

export interface FlowGraph {
    version: 1;
    nodes: FlowNode[];
    edges: FlowEdge[];
}

/** Row shape in the flows list (no graph — just the summary). */
export interface FlowSummary {
    flowId: string;
    name: string;
    enabled: boolean;
    nodeCount: number;
    createdAt: string;
    updatedAt: string;
}

/** A single flow, graph included. */
export interface Flow {
    flowId: string;
    name: string;
    enabled: boolean;
    graph: FlowGraph;
    createdAt: string;
    updatedAt: string;
}

export interface DeployResult {
    ok: true;
    messageId: string;
}
