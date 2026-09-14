import {
    DISCORD_CUSTOM_ID_MAX_LENGTH,
    FLOW_CHOICE_CUSTOM_ID_PREFIX,
    FLOW_CUSTOM_ID_PREFIX,
} from '../constants';

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

/** One button on a question a parked run asked. */
export interface ParsedFlowChoiceCustomId {
    runId: string;
    nodeId: string;
    /** Which of the node's declared choices this button is, by position. */
    index: number;
}

/**
 * Build the custom_id for one choice button: `flowc:<runId>:<nodeId>:<index>`.
 *
 * Addressed to a **run**, not a flow: two members can be parked on the same node
 * of the same flow at once, and a press has to advance the presser's own run
 * rather than whichever the engine happened to find first. That is the difference
 * between this and a trigger button, which starts a new run and so needs only to
 * name the graph.
 *
 * **Position, not a label.** A four-segment id of two 36-character ids already
 * spends 81 of Discord's 100 characters at the worst case this repo can produce
 * (UUID node ids, which the shipped templates use); an author's arbitrary button
 * text does not reliably fit in what is left, and a small integer always does.
 *
 * Throws rather than truncating when the id will not fit. A truncated id parses
 * to a different node — or to none — so silently shortening it would advance the
 * wrong branch of the right run, which is worse than a question that fails to
 * post and says why.
 */
export function buildFlowChoiceCustomId(runId: string, nodeId: string, index: number): string {
    const customId = `${FLOW_CHOICE_CUSTOM_ID_PREFIX}:${runId}:${nodeId}:${index}`;
    if (customId.length > DISCORD_CUSTOM_ID_MAX_LENGTH) {
        throw new Error(
            `Choice button id for node ${nodeId} of run ${runId} is ${customId.length} characters, ` +
                `over Discord's ${DISCORD_CUSTOM_ID_MAX_LENGTH}. Shorten the node's id — ids this long ` +
                'come from hand-written graphs, not from the builder.'
        );
    }
    return customId;
}

/**
 * Parse `flowc:<runId>:<nodeId>:<index>`, or null when it is not one of ours.
 *
 * Four segments where a trigger id has three, which is why this scheme needed its
 * own prefix: `parseFlowCustomId` rejects a fourth segment outright, so the two
 * parsers cannot be merged without one of them accepting the other's ids.
 *
 * The index is required to be a non-negative integer in its plain decimal form:
 * `Number` alone would take `'1e0'`, `' 1'` and `'1.0'`, all of which name choice
 * 1 while no button this engine builds is labelled any of them. An id that did
 * not come from {@link buildFlowChoiceCustomId} is one this did not send.
 */
export function parseFlowChoiceCustomId(customId: string): ParsedFlowChoiceCustomId | null {
    const parts = customId.split(':');
    if (parts.length !== 4 || parts[0] !== FLOW_CHOICE_CUSTOM_ID_PREFIX) {
        return null;
    }
    const [, runId, nodeId, rawIndex] = parts;
    if (!runId || !nodeId || !rawIndex) {
        return null;
    }
    if (!/^\d+$/.test(rawIndex)) {
        return null;
    }
    return { runId, nodeId, index: Number(rawIndex) };
}
