import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Guild } from 'discord.js';
import { flashChatRepo } from '../../features/flash-chat/data/flashChatRepo';
import type { FlashChatConfig } from '../../features/flash-chat/data/flashChatSchema';
import { flashChatManager } from '../../features/flash-chat/flashChatManager';
import { flashChatService } from '../../features/flash-chat/flashChatService';
import { checkFlashChatChannel } from '../../features/flash-chat/logic/flashChatChannel';
import type { AppEnv } from '../types';
import { FlashChatChannelSchema, FlashChatSettingsSchema, type FlashChatChannelBody } from './flashChatBody';
import {
    apiRouter,
    errorBodyResponse,
    GUILD_SCOPED_BODY_ERRORS,
    GUILD_SCOPED_ERRORS,
    GuildPathSchema,
    jsonBody,
    jsonResponse,
} from './openApi';

const FlashChatChannelPathSchema = GuildPathSchema.extend({
    channelId: z.string(),
});

const listFlashChatChannelsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/flash-chat',
    operationId: 'listFlashChatChannels',
    tags: ['flash-chat'],
    summary: 'The channels flash chat is on in',
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse(
            'Every flash chat channel in the server, oldest set-up first.',
            z.object({ channels: z.array(FlashChatChannelSchema) })
        ),
        ...GUILD_SCOPED_ERRORS,
    },
});

const saveFlashChatChannelRoute = createRoute({
    method: 'put',
    path: '/{guildId}/flash-chat/{channelId}',
    operationId: 'saveFlashChatChannel',
    tags: ['flash-chat'],
    summary: 'Turn flash chat on in a channel, or change its settings there',
    request: { params: FlashChatChannelPathSchema, body: jsonBody(FlashChatSettingsSchema) },
    responses: {
        200: jsonResponse(
            'The channel as saved. `running` is false when the bot could not start deleting there.',
            FlashChatChannelSchema
        ),
        ...GUILD_SCOPED_BODY_ERRORS,
        400: errorBodyResponse(
            'The body was refused, the channel is not a text channel in this server, the bot is missing ' +
                'permissions there (the sentence names them), or the server id is missing.'
        ),
    },
});

const deleteFlashChatChannelRoute = createRoute({
    method: 'delete',
    path: '/{guildId}/flash-chat/{channelId}',
    operationId: 'deleteFlashChatChannel',
    tags: ['flash-chat'],
    summary: 'Turn flash chat off in a channel and forget its settings',
    request: { params: FlashChatChannelPathSchema },
    responses: {
        204: { description: 'Turned off.' },
        ...GUILD_SCOPED_ERRORS,
        404: errorBodyResponse('The bot is not in this server, or flash chat is not on in that channel.'),
    },
});

/**
 * Flash chat's settings, one channel at a time. Every write goes through `flashChatService`,
 * the path `/flash-chat` takes too, so a save here starts, restarts or stops the channel's
 * deleting at once and tells the channel exactly when the slash command would.
 */
export function flashChatRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        router.openapi(listFlashChatChannelsRoute, async (c) => {
            const guild = c.get('guild');
            const configs = await flashChatRepo.listByGuild(guild.id);
            return c.json({ channels: configs.map((config) => flashChatChannelView(guild, config)) }, 200);
        });

        // The channel is checked before anything is saved, so a refusal leaves no row behind.
        router.openapi(saveFlashChatChannelRoute, async (c) => {
            const guild = c.get('guild');
            const check = checkFlashChatChannel(guild, c.req.valid('param').channelId);
            if (!check.ok) return c.json({ error: check.message }, 400);

            const config = await flashChatService.configure({
                channel: check.channel,
                settings: c.req.valid('json'),
                by: c.get('user'),
            });
            return c.json(flashChatChannelView(guild, config), 200);
        });

        // Works on a channel Discord has deleted too: its settings are what is left to remove.
        router.openapi(deleteFlashChatChannelRoute, async (c) => {
            const guild = c.get('guild');
            const removed = await flashChatService.remove(guild, c.req.valid('param').channelId);
            if (!removed) return c.json({ error: "Flash chat isn't on in that channel." }, 404);
            return c.body(null, 204);
        });
    });
}

function flashChatChannelView(guild: Guild, config: FlashChatConfig): FlashChatChannelBody {
    return {
        channelId: config.channelId,
        channelName: guild.channels.cache.get(config.channelId)?.name ?? null,
        timeoutSeconds: config.timeoutSeconds,
        preservePinned: config.preservePinned,
        preserveHistory: config.preserveHistory,
        running: !!flashChatManager.getInstance(guild.id, config.channelId),
        updatedByName: config.updatedByName,
        updatedAt: config.updatedAt.toISOString(),
    };
}
