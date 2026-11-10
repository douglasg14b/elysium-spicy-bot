import type { ModelMessage, ToolResultPart } from 'ai';

/** The tools that answer only where every reader is staff (`staffOnlyRefusal`). */
export const STAFF_ONLY_TOOLS = ['getBotFeature', 'findTickets', 'readChannelMessages'] as const;

const STAFF_ONLY = new Set<string>(STAFF_ONLY_TOOLS);

/** What a kept trace holds in place of a staff-only result. */
function strippedOutput(part: ToolResultPart): ToolResultPart['output'] {
    const value = part.output.type === 'json' ? part.output.value : null;
    const page = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        type: 'json',
        value: {
            note: `Not kept between turns: call ${part.toolName} again if you need it.`,
            // Where a read reached, so a follow-up can carry on from there; nothing that was read.
            ...('channel' in page && 'continueBefore' in page ? { channel: page.channel, continueBefore: page.continueBefore } : {}),
        },
    };
}

/**
 * A turn's messages as a session keeps them: every staff-only tool's result reduced to a
 * note. Those answered for the readers of that moment, and a trace is replayed for up to
 * half an hour — after a member joined the thread, say — so a follow-up must ask the tool
 * again, through the gate again. It also keeps a trace of ten pages from outgrowing the
 * history it is replayed into.
 */
export function withoutStaffOnlyResults(messages: readonly ModelMessage[]): ModelMessage[] {
    return messages.map((message) => {
        if (message.role !== 'tool') return message;
        return {
            ...message,
            content: message.content.map((part) =>
                part.type === 'tool-result' && STAFF_ONLY.has(part.toolName) ? { ...part, output: strippedOutput(part) } : part
            ),
        };
    });
}
