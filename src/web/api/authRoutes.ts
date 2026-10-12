import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { WEB_PUBLIC_URL } from '../../environment';
import type { AppEnv } from '../types';
import { botDisplayName } from './botRoutes';
import { hasManageableBotGuild, isSuperuser } from './guildAccess';
import { AUTHED_ERRORS, apiRouter, errorBodyResponse, jsonResponse } from './openApi';
import {
    buildAuthorizeUrl,
    exchangeCode,
    fetchDiscordUser,
    fetchManageableGuildIds,
    issueState,
    verifyState,
} from '../auth/oauth';
import { clearSessionCookie, mintSession, readSession, writeSessionCookie } from '../auth/session';

/** The signed-in person, as the dashboard shows them. */
const AuthUserSchema = z
    .object({
        id: z.string(),
        username: z.string(),
        avatar: z.string().nullable(),
    })
    .openapi('AuthUser', {
        description: 'The signed-in Discord user. `avatar` is the avatar hash, null when they have none.',
    });

const LogoutResultSchema = z
    .object({
        ok: z.literal(true),
    })
    .openapi('LogoutResult', { description: 'The session cookie is cleared.' });

/** The two values Discord sends back. Optional, because the handler names which is wrong. */
const LoginCallbackQuerySchema = z.object({
    code: z.string().optional().openapi({ description: "Discord's authorization code." }),
    state: z.string().optional().openapi({ description: 'The signed state this server issued at login.' }),
});

/** A redirect, described by where it sends the browser. */
function redirectResponse(description: string) {
    return {
        description,
        headers: z.object({ Location: z.string().openapi({ description: 'Where the browser is sent.' }) }),
    };
}

const loginRoute = createRoute({
    method: 'get',
    path: '/login',
    operationId: 'login',
    tags: ['auth'],
    summary: 'Start signing in with Discord (a browser navigation, not a fetch)',
    responses: {
        302: redirectResponse("To Discord's authorize page, with a signed state also set as a cookie."),
    },
});

const loginCallbackRoute = createRoute({
    method: 'get',
    path: '/callback',
    operationId: 'loginCallback',
    tags: ['auth'],
    summary: "Finish signing in: Discord's redirect back (a browser navigation, not a fetch)",
    request: { query: LoginCallbackQuerySchema },
    responses: {
        302: redirectResponse('To the dashboard, signed in: the session cookie is set.'),
        400: errorBodyResponse('The state is missing, expired or not ours, or Discord sent no code.'),
        403: errorBodyResponse('The user manages no server the bot is in.'),
        502: errorBodyResponse('Discord would not complete the sign-in.'),
    },
});

const getCurrentUserRoute = createRoute({
    method: 'get',
    path: '/me',
    operationId: 'getCurrentUser',
    tags: ['auth'],
    summary: 'Who is signed in',
    responses: {
        200: jsonResponse('The signed-in user.', AuthUserSchema),
        401: errorBodyResponse('Nobody is signed in. The normal answer before login.'),
    },
});

const logoutRoute = createRoute({
    method: 'post',
    path: '/logout',
    operationId: 'logout',
    tags: ['auth'],
    summary: 'Sign out',
    responses: {
        200: jsonResponse('Signed out.', LogoutResultSchema),
        ...AUTHED_ERRORS,
    },
});

/**
 * Auth surface: `/api/auth/*`. Login, callback and me are public — me answers 401 when
 * there is no session; logout needs the session it clears. See design doc §5.2.
 *
 * Logout's `requireAuth` is mounted by `registerApiRoutes`, on the parent, like every
 * other auth middleware: a route on `apiRouter` carries none of its own.
 *
 * Login and the callback are **browser navigations**, not calls the dashboard makes: the
 * login page links to `/api/auth/login` and Discord sends the browser back to the
 * callback. They are in the spec because they are routes the server serves, and the spec
 * says what they answer — a redirect — rather than offering them as something to fetch.
 */
export function authRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        // Kick off the OAuth flow: redirect to Discord with a signed CSRF state.
        router.openapi(loginRoute, async (c) => {
            const state = await issueState(c);
            return c.redirect(buildAuthorizeUrl(state), 302);
        });

        // OAuth callback: verify state, exchange code, authorize against the allowlist, mint a session.
        router.openapi(loginCallbackRoute, async (c) => {
            const { code, state } = c.req.valid('query');

            if (!(await verifyState(c, state))) {
                return c.json({ error: 'Invalid or expired OAuth state. Try logging in again.' }, 400);
            }
            if (!code) {
                return c.json({ error: 'Missing authorization code.' }, 400);
            }

            let user;
            let manageableGuildIds: string[];
            try {
                const { access_token } = await exchangeCode(code);
                user = await fetchDiscordUser(access_token);
                manageableGuildIds = await fetchManageableGuildIds(access_token);
            } catch (err) {
                console.error('[web/auth] OAuth callback failed:', err);
                return c.json({ error: 'Failed to complete Discord sign-in.' }, 502);
            }

            // Authorization is Discord's own: you get in if you can manage at least one
            // server the bot is in. Superusers bypass the check so they can reach a server
            // they hold no role in. Rejecting here (rather than showing an empty dashboard)
            // keeps the "why can't I see anything?" case an explicit, readable error.
            if (!isSuperuser(user.id) && !hasManageableBotGuild(manageableGuildIds)) {
                return c.json(
                    {
                        error:
                            `You don't manage any servers that ${botDisplayName()} is in. You need Manage Server ` +
                            'or Administrator on a server the bot has been invited to.',
                    },
                    403
                );
            }

            const token = await mintSession({
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                manageableGuildIds,
            });
            writeSessionCookie(c, token);

            // Back to the SPA root.
            return c.redirect(`${WEB_PUBLIC_URL}/`, 302);
        });

        // Current session (public: returns 401 when there is none).
        router.openapi(getCurrentUserRoute, async (c) => {
            const user = await readSession(c);
            if (!user) {
                return c.json({ error: 'Not authenticated' }, 401);
            }
            return c.json({ id: user.id, username: user.username, avatar: user.avatar }, 200);
        });

        // Clear the session cookie. `requireAuth` runs first, mounted in `registerApiRoutes`.
        router.openapi(logoutRoute, (c) => {
            clearSessionCookie(c);
            return c.json({ ok: true as const }, 200);
        });
    });
}
