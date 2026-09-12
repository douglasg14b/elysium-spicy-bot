import { FLOW_CUSTOM_ID_PREFIX } from '../constants';

export interface ParsedFlowCustomId {
    flowId: string;
    nodeId: string;
}

/** Build the custom_id for a flow trigger button: `flow:<flowId>:<nodeId>`. */
export function buildFlowCustomId(flowId: string, nodeId: string): string {
    return `${FLOW_CUSTOM_ID_PREFIX}:${flowId}:${nodeId}`;
}

/** True when a custom_id belongs to a flow trigger button. */
export function isFlowCustomId(customId: string): boolean {
    return customId.startsWith(`${FLOW_CUSTOM_ID_PREFIX}:`);
}

/**
 * Parse `flow:<flowId>:<nodeId>`. Returns null when the id is not a flow id or
 * is malformed. flowId is a UUID and nodeId a graph node id — neither contains
 * a colon, so a simple split is safe.
 */
export function parseFlowCustomId(customId: string): ParsedFlowCustomId | null {
    const parts = customId.split(':');
    if (parts.length !== 3 || parts[0] !== FLOW_CUSTOM_ID_PREFIX) {
        return null;
    }
    const [, flowId, nodeId] = parts;
    if (!flowId || !nodeId) {
        return null;
    }
    return { flowId, nodeId };
}
