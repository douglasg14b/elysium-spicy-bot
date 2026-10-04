import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { DISCORD_CLIENT } from '../../discordClient';
import { apiRouter, jsonResponse } from './openApi';

/**
 * Which bot account the dashboard is talking to. `development` is the BrattyBot Dev
 * application, `production` the live one.
 */
const BotFlavourSchema = z.enum(['development', 'production']).openapi('BotFlavour', {
    description: 'Which bot application the dashboard is connected to, read off its name.',
});

type BotFlavour = z.infer<typeof BotFlavourSchema>;

/**
 * The wire shape for bot identity. `ready` is false during the cold-start window
 * described in {@link botRoutes} — every other field is null until the gateway
 * connects, and the client falls back to its bundled branding.
 *
 * `flavour` is a union with `null` rather than `.nullable()`: the generator copies a named
 * schema's name onto its nullable variant, so `BotFlavour` itself would become nullable.
 */
const BotIdentitySchema = z
    .object({
        ready: z.boolean(),
        id: z.string().nullable(),
        username: z.string().nullable(),
        flavour: z.union([BotFlavourSchema, z.null()]),
    })
    .openapi('BotIdentity', {
        description:
            'The bot account the dashboard is connected to. Every field but `ready` is null while the ' +
            'gateway is still connecting; show the bundled branding then.',
    });

type BotIdentityResponse = z.infer<typeof BotIdentitySchema>;

/**
 * The connected bot's name for use in server-rendered copy, falling back to the
 * product name before the gateway connects. Prefer this over a hardcoded name so
 * messages from the dev deployment name the dev bot.
 */
export function botDisplayName(): string {
    return DISCORD_CLIENT.isReady() ? DISCORD_CLIENT.user.username : 'BrattyBot';
}

/**
 * A bot account whose name ends in a "dev" marker is a development application — the
 * live dev account is `BrattyBot-Dev`. The name is set in the Discord Developer Portal
 * and arrives over the gateway, so it tracks the token actually in use rather than
 * local config: a prod deploy pointed at the dev token still reports `development`,
 * which is the honest answer.
 *
 * The marker must be a whole trailing word so "Devious" does not read as dev. The
 * separator is any non-alphanumeric rather than `\b`, because `_` is a word character
 * — `BrattyBot_Dev` would otherwise be misread as production.
 */
function resolveFlavour(username: string): BotFlavour {
    return /(^|[^a-z0-9])dev(elopment)?$/i.test(username.trim()) ? 'development' : 'production';
}

const getBotIdentityRoute = createRoute({
    method: 'get',
    path: '/',
    operationId: 'getBotIdentity',
    tags: ['bot'],
    summary: 'Which bot account the dashboard is connected to',
    responses: {
        200: jsonResponse(
            'The bot identity, or `ready: false` with every other field null while the gateway connects.',
            BotIdentitySchema
        ),
    },
});

/**
 * Public bot-identity surface.
 *
 * Public because the login page renders it before any session exists. Only the bot's
 * own id and username are exposed — both are already visible to anyone who shares a
 * server with the bot, and the id is public in the OAuth authorize URL. Nothing
 * guild-scoped or environmental belongs here.
 *
 * The web server binds its port before `DISCORD_CLIENT.login()` is called and does not
 * await it, so this route is reachable while the gateway is still connecting. It answers
 * `ready: false` rather than failing: the dashboard has bundled branding to fall back on,
 * and a 503 would make a normal cold start look like an outage.
 */
export function botRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        router.openapi(getBotIdentityRoute, (c) => {
            if (!DISCORD_CLIENT.isReady()) {
                return c.json({ ready: false, id: null, username: null, flavour: null }, 200);
            }

            const botUser = DISCORD_CLIENT.user;
            return c.json(
                {
                    ready: true,
                    id: botUser.id,
                    username: botUser.username,
                    flavour: resolveFlavour(botUser.username),
                },
                200
            );
        });
    });
}

export type { BotIdentityResponse };
export { resolveFlavour };
