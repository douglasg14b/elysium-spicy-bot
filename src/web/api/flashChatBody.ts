import { z } from '@hono/zod-openapi';
import { FLASH_CHAT_MAX_TIMEOUT_SECONDS } from '../../features/flash-chat/constants';

/**
 * What an operator picks for one flash chat channel. The same bounds as the slash command's
 * `timeout` option; whether the channel can run it is the handler's question
 * (`checkFlashChatChannel`), asked of the guild's caches.
 */
export const FlashChatSettingsSchema = z
    .object({
        timeoutSeconds: z
            .number()
            .int('A timer counts whole seconds.')
            .min(1, 'Give messages at least a second to live.')
            .max(FLASH_CHAT_MAX_TIMEOUT_SECONDS, 'Fourteen days is the longest a message can wait to die.'),
        preservePinned: z.boolean(),
        preserveHistory: z.boolean(),
    })
    .openapi('FlashChatSettings');

/** One channel flash chat is on in, as the dashboard lists it. */
export const FlashChatChannelSchema = z
    .object({
        channelId: z.string(),
        channelName: z
            .union([z.string(), z.null()])
            .describe('Null when the channel is gone from the server: its settings outlived it.'),
        timeoutSeconds: z.number().int(),
        preservePinned: z.boolean(),
        preserveHistory: z.boolean(),
        running: z
            .boolean()
            .describe(
                'Whether the bot is deleting in it right now. False when it could not start: the channel ' +
                    'is gone, or the bot lost its permissions there.'
            ),
        updatedByName: z.string(),
        updatedAt: z.string().describe('ISO 8601.'),
    })
    .openapi('FlashChatChannel');

export type FlashChatChannelBody = z.infer<typeof FlashChatChannelSchema>;
