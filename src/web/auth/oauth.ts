import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import {
    DISCORD_APP_ID,
    DISCORD_OAUTH_CLIENT_SECRET,
    ENV,
    SESSION_SECRET,
    WEB_PUBLIC_URL,
} from '../../environment';

/**
 * Discord OAuth2 authorization-code flow. Scopes `identify guilds`.
 * CSRF is defended with a signed, short-lived `state` value stored in its own cookie
 * and verified on the callback.
 */

const DISCORD_API_BASE = 'https://discord.com/api';
export const OAUTH_SCOPES = 'identify guilds';
export const OAUTH_STATE_COOKIE = 'spicy_oauth_state';
/** State cookie TTL — the login round-trip is short-lived. */
const STATE_TTL_SECONDS = 10 * 60;

/** Discord's `Manage Guild` permission bit. Present in the OAuth `guilds` payload's `permissions`. */
const MANAGE_GUILD = 0x20n;

/** The `/users/@me` shape we care about. */
export interface DiscordUser {
    id: string;
    username: string;
    avatar: string | null;
}

/** A single entry from `/users/@me/guilds`. */
interface DiscordPartialGuild {
    id: string;
    name: string;
    owner: boolean;
    /** Permissions bitfield as a string, from the user's perspective in this guild. */
    permissions: string;
}

function requireSecret(): string {
    if (!SESSION_SECRET) {
        throw new Error('SESSION_SECRET is not configured; the web server should not have started.');
    }
    return SESSION_SECRET;
}

/** The registered redirect URI. Discord must have this exact value allowlisted. */
export function redirectUri(): string {
    return `${WEB_PUBLIC_URL}/api/auth/callback`;
}

/** Builds the Discord authorize URL for the given signed `state`. */
export function buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
        client_id: DISCORD_APP_ID,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: OAUTH_SCOPES,
        state,
        prompt: 'consent',
    });
    return `${DISCORD_API_BASE}/oauth2/authorize?${params.toString()}`;
}

/** Mints a short-lived signed state token and stores it in a cookie. Returns the token. */
export async function issueState(c: Context): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const token = await sign({ nonce, iat: now, exp: now + STATE_TTL_SECONDS }, requireSecret(), 'HS256');
    setCookie(c, OAUTH_STATE_COOKIE, token, {
        httpOnly: true,
        secure: ENV !== 'development',
        sameSite: 'Lax',
        path: '/',
        maxAge: STATE_TTL_SECONDS,
    });
    return token;
}

/** Verifies the callback `state` against the signed state cookie (CSRF check). */
export async function verifyState(c: Context, stateFromQuery: string | undefined): Promise<boolean> {
    const cookie = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
    if (!stateFromQuery || !cookie) return false;
    // The state we handed the browser is the same signed token we set in the cookie.
    if (stateFromQuery !== cookie) return false;
    try {
        await verify(cookie, requireSecret(), 'HS256');
        return true;
    } catch {
        return false;
    }
}

interface TokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
}

/** Exchanges an authorization code for an access token. Throws on non-OK responses. */
export async function exchangeCode(code: string): Promise<TokenResponse> {
    if (!DISCORD_OAUTH_CLIENT_SECRET) {
        throw new Error('DISCORD_OAUTH_CLIENT_SECRET is not configured.');
    }
    const body = new URLSearchParams({
        client_id: DISCORD_APP_ID,
        client_secret: DISCORD_OAUTH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
    });
    const res = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as TokenResponse;
}

/** Fetches the authenticated user (`/users/@me`). */
export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
    const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        throw new Error(`Discord /users/@me failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as DiscordUser;
}

/**
 * Fetches the user's guilds (`/users/@me/guilds`) and returns the ids of guilds where
 * they own or hold Manage Guild — the set the dashboard treats as "manageable".
 */
export async function fetchManageableGuildIds(accessToken: string): Promise<string[]> {
    const res = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        throw new Error(`Discord /users/@me/guilds failed: ${res.status} ${await res.text()}`);
    }
    const guilds = (await res.json()) as DiscordPartialGuild[];
    return guilds
        .filter((g) => {
            if (g.owner) return true;
            try {
                return (BigInt(g.permissions) & MANAGE_GUILD) === MANAGE_GUILD;
            } catch {
                return false;
            }
        })
        .map((g) => g.id);
}
