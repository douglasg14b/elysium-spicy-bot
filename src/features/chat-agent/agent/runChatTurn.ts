import { hasToolCall, stepCountIs, ToolLoopAgent } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import type { ChatTools } from '../tools/buildChatTools';
import type { ChatToolContext } from '../tools/chatToolContext';
import { staffHelpAccess } from '../tools/staffAccess';
import { STAY_QUIET_TOOL } from '../tools/stayQuietTool';
import { buildChatInstructions } from './chatInstructions';

/** Tool rounds before the agent must answer with what it has. */
export const MAX_AGENT_STEPS = 6;

/** A turn where staff may read back through a channel: its page budget, a few lookups, and the answer. */
export const STAFF_MAX_AGENT_STEPS = 16;

/** How long a turn may run before it is given up, by the same split. */
const TURN_TIMEOUT_MS = 90_000;
const STAFF_TURN_TIMEOUT_MS = 180_000;

type TurnLimits = { readonly maxSteps: number; readonly timeoutMs: number };

/** Longer for a turn the staff-only tools will answer in; every other turn keeps the short leash. */
export function turnLimitsFor(context: ChatToolContext): TurnLimits {
    return staffHelpAccess(context.viewers, context.staffRoleIds) === 'allowed'
        ? { maxSteps: STAFF_MAX_AGENT_STEPS, timeoutMs: STAFF_TURN_TIMEOUT_MS }
        : { maxSteps: MAX_AGENT_STEPS, timeoutMs: TURN_TIMEOUT_MS };
}

/** Generous for a chat reply; a runaway answer is cut by the send anyway. */
const MAX_OUTPUT_TOKENS = 1_200;

export type ChatTurnInput = {
    readonly context: ChatToolContext;
    /** Normally `buildChatTools(context)`; a fixture run swaps their results for canned ones. */
    readonly tools: ChatTools;
    /** The conversation so far, ending with the message being answered. */
    readonly messages: readonly ModelMessage[];
    readonly model: LanguageModel;
    readonly botName: string;
    /** Defaults to BrattyBot's persona; the evals pass another to compare voices. */
    readonly persona?: string;
    /** The server's time zone, so the agent knows what time it is there. */
    readonly timeZone?: string;
    /** Tool rounds allowed; {@link MAX_AGENT_STEPS} unless the caller's {@link turnLimitsFor} says more. */
    readonly maxSteps?: number;
    readonly abortSignal?: AbortSignal;
};

export type ChatTurnResult = {
    /** The reply text; empty when the model gave none, which the caller must handle. */
    readonly text: string;
    /** Everything the model produced this turn — tool calls, results, the reply — for the session. */
    readonly responseMessages: readonly ModelMessage[];
    /** Names of the tools called, in order, for logging. */
    readonly toolCalls: readonly string[];
    readonly steps: number;
    /** The agent chose to say nothing (`stayQuiet`, tickets only): post nothing, remember nothing. */
    readonly stayedQuiet: boolean;
};

/** Every tool, but `stayQuiet` only in a ticket. */
function activeToolsFor(input: ChatTurnInput): (keyof ChatTools)[] {
    const names = Object.keys(input.tools) as (keyof ChatTools)[];
    return input.context.ticket ? names : names.filter((name) => name !== STAY_QUIET_TOOL);
}

/**
 * One turn of the chat agent: given the conversation and where it is happening, let the
 * model look things up with its tools for up to `maxSteps` rounds and answer.
 *
 * Built per turn because the tools close over this turn's server, channel and asker.
 * Has no Discord side effects of its own — tools only read — so the caller owns posting.
 */
export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const agent = new ToolLoopAgent({
        model: input.model,
        instructions: buildChatInstructions(input.context, input.botName, input.persona, input.timeZone),
        tools: input.tools,
        activeTools: activeToolsFor(input),
        stopWhen: [stepCountIs(input.maxSteps ?? MAX_AGENT_STEPS), hasToolCall(STAY_QUIET_TOOL)],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    const result = await agent.generate({ messages: [...input.messages], abortSignal: input.abortSignal });

    const toolCalls = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
    return {
        text: result.text,
        responseMessages: result.responseMessages,
        toolCalls,
        steps: result.steps.length,
        stayedQuiet: toolCalls.includes(STAY_QUIET_TOOL),
    };
}
