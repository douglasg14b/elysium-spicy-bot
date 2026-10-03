import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Guild } from 'discord.js';
import { guildSettingsRepo } from '../../features-system/guild-settings';
import { warningsConfigRepo } from '../../features/warnings/data/warningsConfigRepo';
import { setWarningsModChannel } from '../../features/warnings/logic/setWarningsModChannel';
import type { AppEnv } from '../types';
import { accessibleGuilds } from './guildAccess';
import {
    GuildChannelSchema,
    guildChannelBodies,
    GuildRoleSchema,
    GuildSchema,
    GuildSettingsSchema,
    WarningsConfigSchema,
    type GuildSettingsBody,
    type WarningsConfigBody,
} from './guildBody';
import {
    apiRouter,
    AUTHED_ERRORS,
    GUILD_SCOPED_BODY_ERRORS,
    GUILD_SCOPED_ERRORS,
    GuildPathSchema,
    jsonBody,
    jsonResponse,
} from './openApi';

/*
 * Request bodies are validated by `router.openapi` before a handler runs, and a failure
 * answers with the first issue's message (see `apiRouter`).
 *
 * What a schema states here is also what the dashboard checks before sending, through
 * the zod the SDK generates from the spec — so a rule belongs here only if the server
 * enforces it. The messages do not cross; the browser learns *whether*, not *why*.
 */

const WarningsConfigUpdateSchema = z
    .object({
        modChannelId: z.string().min(1, 'Pick a channel. Warning notices do not haunt the void.'),
    })
    .openapi('WarningsConfigUpdate');

/**
 * Staff roles arrive as a list of ids, and an **empty list is legal**: it is how an
 * operator says "nobody is staff here yet", and refusing it would leave no way to undo
 * a mistake short of deleting the row. Whether those ids exist in the guild is checked
 * against the live role cache below, not here — Zod cannot see Discord.
 */
const GuildSettingsUpdateSchema = z
    .object({
        staffRoleIds: z.array(z.string().min(1)),
    })
    .openapi('GuildSettingsUpdate');

const listGuildsRoute = createRoute({
    method: 'get',
    path: '/',
    operationId: 'listGuilds',
    tags: ['guilds'],
    summary: 'Guilds the bot is in that the signed-in user may manage',
    responses: {
        200: jsonResponse('The manageable guilds.', z.object({ guilds: z.array(GuildSchema) })),
        ...AUTHED_ERRORS,
    },
});

const getGuildChannelsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/channels',
    operationId: 'getGuildChannels',
    tags: ['guilds'],
    summary: "The guild's text channels and categories",
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse('The channel directory.', z.object({ channels: z.array(GuildChannelSchema) })),
        ...GUILD_SCOPED_ERRORS,
    },
});

const getGuildRolesRoute = createRoute({
    method: 'get',
    path: '/{guildId}/roles',
    operationId: 'getGuildRoles',
    tags: ['guilds'],
    summary: "The guild's assignable roles",
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse('Assignable roles, highest first.', z.object({ roles: z.array(GuildRoleSchema) })),
        ...GUILD_SCOPED_ERRORS,
    },
});

const getWarningsConfigRoute = createRoute({
    method: 'get',
    path: '/{guildId}/config/warnings',
    operationId: 'getWarningsConfig',
    tags: ['guilds'],
    summary: 'The warnings mod-log channel',
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse('The warnings config.', WarningsConfigSchema),
        ...GUILD_SCOPED_ERRORS,
    },
});

const updateWarningsConfigRoute = createRoute({
    method: 'put',
    path: '/{guildId}/config/warnings',
    operationId: 'updateWarningsConfig',
    tags: ['guilds'],
    summary: 'Set the warnings mod-log channel',
    request: { params: GuildPathSchema, body: jsonBody(WarningsConfigUpdateSchema) },
    responses: {
        200: jsonResponse('The warnings config as saved.', WarningsConfigSchema),
        ...GUILD_SCOPED_BODY_ERRORS,
    },
});

const getGuildSettingsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/settings',
    operationId: 'getGuildSettings',
    tags: ['guilds'],
    summary: 'Server-wide settings: staff roles',
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse('The guild settings.', GuildSettingsSchema),
        ...GUILD_SCOPED_ERRORS,
    },
});

const updateGuildSettingsRoute = createRoute({
    method: 'put',
    path: '/{guildId}/settings',
    operationId: 'updateGuildSettings',
    tags: ['guilds'],
    summary: "Replace the guild's staff roles",
    request: { params: GuildPathSchema, body: jsonBody(GuildSettingsUpdateSchema) },
    responses: {
        200: jsonResponse('The guild settings as saved.', GuildSettingsSchema),
        ...GUILD_SCOPED_BODY_ERRORS,
    },
});

/**
 * Guild data + feature config. All routes require auth; everything under `:guildId` is
 * additionally authorized by `requireGuildAccess`, which resolves `c.get('guild')`.
 * See design doc §5.2 / §5.3.
 *
 * Described by the OpenAPI spec: each route's `createRoute` definition is its contract,
 * and the dashboard's SDK is generated from it.
 */
export function guildRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        // Guilds the bot is in that this user may manage.
        router.openapi(listGuildsRoute, (c) => {
            const guilds = accessibleGuilds(c.get('user')).map((g) => ({
                id: g.id,
                name: g.name,
                iconURL: g.iconURL({ size: 128 }),
                memberCount: g.memberCount,
            }));
            return c.json({ guilds }, 200);
        });

        /*
         * The guild's channels, for every picker that names one.
         *
         * Carries `type` and the parent, which is what lets a caller tell two channels
         * called `#general` apart and lets a category be adopted at all. Categories are in
         * the list rather than filtered out here: a consumer that must not offer one as a
         * place to post filters on `type`, and doing it at the endpoint made that
         * invariant invisible to the code depending on it.
         */
        router.openapi(getGuildChannelsRoute, (c) => {
            return c.json({ channels: guildChannelBodies(c.get('guild')) }, 200);
        });

        // Assignable roles for a guild (role-picker display). Excludes @everyone and
        // managed (bot/integration) roles — neither can be assigned by a flow.
        router.openapi(getGuildRolesRoute, (c) => {
            const guild = c.get('guild');
            const roles = [...guild.roles.cache.values()]
                .filter((role) => isAssignableRole(guild, role.id))
                .sort((a, b) => b.position - a.position)
                .map((role) => ({
                    id: role.id,
                    name: role.name,
                    color: role.color,
                    position: role.position,
                }));

            return c.json({ roles }, 200);
        });

        // Read-only warnings config, with the mod-log channel name resolved for display.
        router.openapi(getWarningsConfigRoute, async (c) => {
            const guild = c.get('guild');
            const config = await warningsConfigRepo.getByGuildId(guild.id);
            return c.json(resolveWarningsConfig(guild, config?.modChannelId ?? null), 200);
        });

        // Update the warnings mod-log channel. Validates + persists via the shared
        // {@link setWarningsModChannel} — the same path the Discord slash-modal uses.
        router.openapi(updateWarningsConfigRoute, async (c) => {
            const guild = c.get('guild');
            const { modChannelId } = c.req.valid('json');

            const result = await setWarningsModChannel(guild.id, modChannelId);
            if (!result.ok) {
                return c.json({ error: result.message }, 400);
            }

            return c.json(resolveWarningsConfig(guild, result.config.modChannelId), 200);
        });

        // Guild-wide settings owned by no single feature. Today: staff roles.
        router.openapi(getGuildSettingsRoute, async (c) => {
            const guild = c.get('guild');
            const staffRoleIds = await guildSettingsRepo.getStaffRoleIds(guild.id);
            return c.json(resolveGuildSettings(guild, staffRoleIds), 200);
        });

        /*
         * Replace this guild's staff roles.
         *
         * Ids are checked against the guild's live roles before anything is stored. A
         * deleted or foreign role id would otherwise sit in the table looking valid and
         * fail much later, during an install, as a permission intent that resolves to a
         * role Discord has never heard of — far from the form that accepted it.
         */
        router.openapi(updateGuildSettingsRoute, async (c) => {
            const guild = c.get('guild');

            // Deduplicated before storing: the same role twice is the same permission
            // overwrite twice, and the list is a set in everything but its type.
            const staffRoleIds = [...new Set(c.req.valid('json').staffRoleIds)];

            /*
             * Only *newly added* ids are validated. An id already saved is left alone even
             * if it no longer resolves, so deleting a staff role in Discord does not make
             * this form permanently unsaveable: the operator can still submit, and the
             * dead id is pruned by the next save that drops it. Validating the whole list
             * would reject every submission on the strength of a role the operator cannot
             * re-create, and the error would name ids they never touched.
             */
            const existing = await guildSettingsRepo.getStaffRoleIds(guild.id);
            const added = staffRoleIds.filter((roleId) => !existing.includes(roleId));
            const rejected = added.filter((roleId) => !isAssignableRole(guild, roleId));
            if (rejected.length > 0) {
                return c.json(
                    {
                        error: `These can't be staff roles: ${rejected.join(', ')}. Pick real, assignable roles — @everyone and bot-managed roles don't count.`,
                    },
                    400
                );
            }

            const saved = await guildSettingsRepo.setStaffRoleIds(guild.id, staffRoleIds);
            return c.json(resolveGuildSettings(guild, saved.staffRoleIds), 200);
        });
    });
}

/**
 * The wire shape for guild settings: stored ids plus their current names, so the
 * dashboard can render a role without a second round trip.
 *
 * A role deleted since it was saved resolves to no name and is dropped from
 * `staffRoles` while staying in `staffRoleIds` — the saved list is reported as saved,
 * rather than quietly rewritten by a read.
 */
function resolveGuildSettings(guild: Guild, staffRoleIds: readonly string[]): GuildSettingsBody {
    const staffRoles = staffRoleIds
        .map((roleId) => guild.roles.cache.get(roleId))
        .filter((role): role is NonNullable<typeof role> => !!role)
        .map((role) => ({ id: role.id, name: role.name }));

    return { staffRoleIds: [...staffRoleIds], staffRoles };
}

/**
 * Whether a role id may be handed to a feature as a real, grantable role.
 *
 * Shared by the role picker and by staff-role validation, because the two drifting
 * apart is a security bug rather than an inconsistency. Two exclusions, and the first
 * is the dangerous one:
 *
 *  - **`@everyone`**, whose id *is the guild id*. A plain cache check accepts it. It
 *    then compiles to an overwrite keyed on the same id as the `everyone` audience,
 *    and since later intents override earlier ones per id
 *    (`compilePermissionIntents`), the canonical "deny everyone, then allow staff"
 *    declaration erases its own deny — producing a world-readable channel that every
 *    plan, embed, and dashboard still reports as staff-only.
 *  - **Managed** roles, which belong to a bot or integration and cannot be assigned.
 */
function isAssignableRole(guild: Guild, roleId: string): boolean {
    const role = guild.roles.cache.get(roleId);
    return !!role && role.id !== guild.id && !role.managed;
}

/** The wire shape for warnings config: id plus resolved channel name for display. */
function resolveWarningsConfig(guild: Guild, modChannelId: string | null): WarningsConfigBody {
    const modChannelName = modChannelId
        ? guild.channels.cache.get(modChannelId)?.name ?? null
        : null;
    return { modChannelId, modChannelName };
}

