import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { ENV, SESSION_SECRET } from '../../environment';

/**
 * Stateless web session. The signed JWT lives in an httpOnly cookie — there is no
 * session table (see design doc §4.4). Coarse revocation is by rotating SESSION_SECRET.
 */

export const SESSION_COOKIE = 'spicy_session';
/** ~7 days, in seconds. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * What we carry in the JWT. `manageableGuildIds` are the guilds where the user has
 * Manage Guild (per the OAuth `guilds` payload); the API intersects these with the
 * bot's guilds. Standard JWT `exp`/`iat` claims are added by {@link mintSession}.
 */
export interface SessionUser {
    id: string;
    username: string;
    /** Discord avatar hash (nullable — user may have no custom avatar). */
    avatar: string | null;
    manageableGuildIds: string[];
}

/**
 * JWT claims. Written as an index-signature-bearing type so it satisfies hono's
 * `JWTPayload` (which requires `[key: string]: unknown`); a plain interface would not.
 */
type SessionClaims = SessionUser & {
    exp: number;
    iat: number;
    [key: string]: unknown;
};

function requireSecret(): string {
    if (!SESSION_SECRET) {
        // WEB_ENABLED gates the server, so this should never happen at runtime.
        throw new Error('SESSION_SECRET is not configured; the web server should not have started.');
    }
    return SESSION_SECRET;
}

/** Signs a session JWT with a ~7 day expiry. */
export async function mintSession(user: SessionUser): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: SessionClaims = {
        ...user,
        iat: now,
        exp: now + SESSION_TTL_SECONDS,
    };
    return sign(claims, requireSecret(), 'HS256');
}

/** Verifies and decodes the session cookie on a request. Returns null if absent/invalid/expired. */
export async function readSession(c: Context): Promise<SessionUser | null> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    try {
        const claims = (await verify(token, requireSecret(), 'HS256')) as unknown as SessionClaims;
        if (!claims.id || !Array.isArray(claims.manageableGuildIds)) return null;
        return {
            id: claims.id,
            username: claims.username,
            avatar: claims.avatar ?? null,
            manageableGuildIds: claims.manageableGuildIds,
        };
    } catch {
        // Invalid signature, malformed, or expired.
        return null;
    }
}

/** Sets the session cookie: httpOnly, sameSite=Lax, secure outside development. */
export function writeSessionCookie(c: Context, token: string): void {
    setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        secure: ENV !== 'development',
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_TTL_SECONDS,
    });
}

/** Clears the session cookie. */
export function clearSessionCookie(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
