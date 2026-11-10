import type { ModelMessage, ToolResultPart } from 'ai';

/**
 * A tool result as a session shows it when it cannot show the result itself — not for these
 * readers, or too big for the budget: a note to ask again, and — for a channel read — where
 * the read reached, so a follow-up can carry on from there. Nothing that was read.
 */
export function withoutResult(part: ToolResultPart): ToolResultPart {
    const value = part.output.type === 'json' ? part.output.value : null;
    const page = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        ...part,
        output: {
            type: 'json',
            value: {
                note: `Not kept: call ${part.toolName} again if you need it.`,
                ...('channel' in page && 'continueBefore' in page ? { channel: page.channel, continueBefore: page.continueBefore } : {}),
            },
        },
    };
}

/** Where a tool result sits in a trace: its message, then its part. */
export type ResultLocation = { readonly messageIndex: number; readonly partIndex: number };

/** `messages` with each tool result passed through `rewrite`; everything else as it was. */
export function mapToolResults(
    messages: readonly ModelMessage[],
    rewrite: (part: ToolResultPart, location: ResultLocation) => ToolResultPart
): ModelMessage[] {
    return messages.map((message, messageIndex) => {
        if (message.role !== 'tool') return message;
        return {
            ...message,
            content: message.content.map((part, partIndex) => (part.type === 'tool-result' ? rewrite(part, { messageIndex, partIndex }) : part)),
        };
    });
}

/** How big a trace is against a budget: its characters as JSON, as the model is sent it. */
export function sizeOf(messages: readonly ModelMessage[]): number {
    return JSON.stringify(messages).length;
}
