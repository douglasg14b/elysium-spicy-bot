import { tool } from 'ai';
import { z } from 'zod';

/** The tool's name; calling it ends the turn with nothing posted. */
export const STAY_QUIET_TOOL = 'stayQuiet';

/**
 * Lets the agent decline to speak. Offered only in tickets, where being mentioned is not
 * enough: the bot answers there only a genuine question about the server, and says nothing
 * to anything else. The agent loop stops as soon as it is called (`runChatTurn`).
 */
export function stayQuietTool() {
    return tool({
        description:
            'Say nothing at all. Call this — and only this — when the mention is not a genuine question about this server that your tools can answer.',
        inputSchema: z.object({
            reason: z.string().describe('A few words on why, for the logs.'),
        }),
        execute: async () => ({ silent: true as const }),
    });
}
