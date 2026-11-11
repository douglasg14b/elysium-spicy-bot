import type { ModelMessage } from 'ai';

/** The tools that answer only where every reader is staff (`staffOnlyRefusal`). */
export const STAFF_ONLY_TOOLS = ['getBotFeature', 'findTickets', 'readChannelMessages', 'getChannelAccess', 'getUserLevel'] as const;

const STAFF_ONLY = new Set<string>(STAFF_ONLY_TOOLS);

/** Whether `messages` called any staff-only tool. */
export function usesStaffOnlyTools(messages: readonly ModelMessage[]): boolean {
    return messages.some(
        (message) => message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part) => part.type === 'tool-call' && STAFF_ONLY.has(part.toolName))
    );
}
