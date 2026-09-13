import type { ButtonInteraction, Client, Guild, GuildMember, User } from 'discord.js';
import type { ZodType } from 'zod';

/**
 * The legacy shape a block declares, kept only until the blocks migrate to the
 * manifest in `./manifest.ts` — at which point this file keeps
 * {@link FlowRunContext} and loses everything else.
 *
 * The kind literals below are spelled out rather than drawn from `BLOCK_KINDS`,
 * because each legacy definition pins exactly one of them. `BLOCK_KINDS` stays
 * the vocabulary the new contract and the conformance suite check against.
 */

/**
 * Runtime context threaded through a single flow execution. Actions call
 * discord.js directly via these handles.
 */
export interface FlowRunContext {
    client: Client;
    guild: Guild;
    /** The member who triggered the flow (present for button/member triggers). */
    member: GuildMember;
    /** Convenience alias for `member.user`. */
    user: User;
    /** The originating interaction, when the trigger was an interaction. */
    interaction?: ButtonInteraction;
}

/**
 * Base fields shared by every node definition. Node definitions are
 * self-describing so Phase 4's builder UI can read the registry to render a
 * palette and per-node config forms.
 */
interface BaseNodeDefinition<TConfig> {
    type: string;
    label: string;
    /** Zod schema validating `node.data` for this node type. */
    configSchema: ZodType<TConfig>;
}

export interface TriggerNodeDefinition<TConfig = unknown> extends BaseNodeDefinition<TConfig> {
    kind: 'trigger';
}

export interface ConditionNodeDefinition<TConfig = unknown> extends BaseNodeDefinition<TConfig> {
    kind: 'condition';
    /** Evaluate the condition and return which output handle to follow. */
    evaluate(config: TConfig, context: FlowRunContext): Promise<'true' | 'false'> | 'true' | 'false';
}

export interface ActionNodeDefinition<TConfig = unknown> extends BaseNodeDefinition<TConfig> {
    kind: 'action';
    /** Perform the side effect (assign role, send DM, etc). */
    execute(config: TConfig, context: FlowRunContext): Promise<void>;
}

export type NodeDefinition<TConfig = unknown> =
    | TriggerNodeDefinition<TConfig>
    | ConditionNodeDefinition<TConfig>
    | ActionNodeDefinition<TConfig>;

export function isTriggerNode(definition: NodeDefinition): definition is TriggerNodeDefinition {
    return definition.kind === 'trigger';
}

export function isConditionNode(definition: NodeDefinition): definition is ConditionNodeDefinition {
    return definition.kind === 'condition';
}

export function isActionNode(definition: NodeDefinition): definition is ActionNodeDefinition {
    return definition.kind === 'action';
}
