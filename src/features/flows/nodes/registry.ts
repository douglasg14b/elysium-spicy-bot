import { actionAssignRoleNode } from './actionAssignRole';
import { actionDelayNode } from './actionDelay';
import { actionPostEmbedNode } from './actionPostEmbed';
import { actionRemoveRoleNode } from './actionRemoveRole';
import { actionSendDMNode } from './actionSendDM';
import { actionSendMessageNode } from './actionSendMessage';
import { actionWaitForEventNode } from './actionWaitForEvent';
import { conditionHasRoleNode } from './conditionHasRole';
import { conditionInChannelNode } from './conditionInChannel';
import { triggerButtonClickNode } from './triggerButtonClick';
import { triggerMemberJoinNode } from './triggerMemberJoin';
import { triggerReactionAddNode } from './triggerReactionAdd';
import type {
    ActionNodeDefinition,
    ConditionNodeDefinition,
    NodeDefinition,
    TriggerNodeDefinition,
} from './types';

/**
 * Self-describing node registry keyed by node `type`. Phase 4's builder UI
 * reads this to render its palette + per-node config forms; the executor reads
 * it to run nodes. Add a new node type by importing its definition here.
 */
const NODE_DEFINITIONS: readonly NodeDefinition[] = [
    triggerButtonClickNode,
    triggerMemberJoinNode,
    triggerReactionAddNode,
    conditionHasRoleNode,
    conditionInChannelNode,
    actionAssignRoleNode,
    actionRemoveRoleNode,
    actionSendDMNode,
    actionSendMessageNode,
    actionPostEmbedNode,
    // Suspending actions — the executor intercepts these by type and parks the
    // run rather than calling their `execute`.
    actionDelayNode,
    actionWaitForEventNode,
];

const NODE_REGISTRY: ReadonlyMap<string, NodeDefinition> = new Map(
    NODE_DEFINITIONS.map((definition) => [definition.type, definition])
);

export function getNodeDefinition(type: string): NodeDefinition | undefined {
    return NODE_REGISTRY.get(type);
}

export function listNodeDefinitions(): readonly NodeDefinition[] {
    return NODE_DEFINITIONS;
}

export function isTriggerNode(definition: NodeDefinition): definition is TriggerNodeDefinition {
    return definition.kind === 'trigger';
}

export function isConditionNode(definition: NodeDefinition): definition is ConditionNodeDefinition {
    return definition.kind === 'condition';
}

export function isActionNode(definition: NodeDefinition): definition is ActionNodeDefinition {
    return definition.kind === 'action';
}
