import { ChannelType, type Guild } from 'discord.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { warningsConfigRepo } from '../../features/warnings/data/warningsConfigRepo';
import { setWarningsModChannel } from '../../features/warnings/logic/setWarningsModChannel';
import type { AppEnv } from '../types';
import { accessibleGuilds } from './guildAccess';

const warningsConfigBody = z.object({
    modChannelId: z.string().min(1, 'Pick a channel. Warning notices do not haunt the void.'),
});

/**
 * Guild data + feature config. All routes require auth; everything under `:guildId` is
 * additionally authorized by `requireGuildAccess`, which resolves `c.get('guild')`.
 * See design doc §5.2 / §5.3.
 */

export function guildRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // Guilds the bot is in that this user may manage.
    app.get('/', (c) => {
        const guilds = accessibleGuilds(c.get('user')).map((g) => ({
            id: g.id,
            name: g.name,
            iconURL: g.iconURL({ size: 128 }),
            memberCount: g.memberCount,
        }));
        return c.json({ guilds });
    });

    // Text channels for a guild (channel-picker display).
    app.get('/:guildId/channels', (c) => {
        const channels = textChannels(c.get('guild')).map((ch) => ({ id: ch.id, name: ch.name }));
        return c.json({ channels });
    });

    // Assignable roles for a guild (role-picker display). Excludes @everyone and
    // managed (bot/integration) roles — neither can be assigned by a flow.
    app.get('/:guildId/roles', (c) => {
        const guild = c.get('guild');
        const roles = [...guild.roles.cache.values()]
            .filter((role) => role.id !== guild.id && !role.managed)
            .sort((a, b) => b.position - a.position)
            .map((role) => ({
                id: role.id,
                name: role.name,
                color: role.color,
                position: role.position,
            }));

        return c.json({ roles });
    });

    // Read-only warnings config, with the mod-log channel name resolved for display.
    app.get('/:guildId/config/warnings', async (c) => {
        const guild = c.get('guild');
        const config = await warningsConfigRepo.getByGuildId(guild.id);
        return c.json(resolveWarningsConfig(guild, config?.modChannelId ?? null));
    });

    // Update the warnings mod-log channel. Validates + persists via the shared
    // {@link setWarningsModChannel} — the same path the Discord slash-modal uses.
    app.put('/:guildId/config/warnings', async (c) => {
        const guild = c.get('guild');
        const parsed = warningsConfigBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            const message = parsed.error.issues[0]?.message ?? 'Invalid request body.';
            return c.json({ error: message }, 400);
        }

        const result = await setWarningsModChannel(guild.id, parsed.data.modChannelId);
        if (!result.ok) {
            return c.json({ error: result.message }, 400);
        }

        return c.json(resolveWarningsConfig(guild, result.config.modChannelId));
    });

    return app;
}

/** The wire shape for warnings config: id plus resolved channel name for display. */
function resolveWarningsConfig(
    guild: Guild,
    modChannelId: string | null
): { modChannelId: string | null; modChannelName: string | null } {
    const modChannelName = modChannelId
        ? guild.channels.cache.get(modChannelId)?.name ?? null
        : null;
    return { modChannelId, modChannelName };
}

/** Text channels of a guild, sorted by name for stable display. */
function textChannels(guild: Guild) {
    return [...guild.channels.cache.values()]
        .filter((ch) => ch.type === ChannelType.GuildText)
        .sort((a, b) => a.name.localeCompare(b.name));
}
