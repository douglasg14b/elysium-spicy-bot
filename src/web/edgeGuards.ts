import { createMiddleware } from 'hono/factory';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './types';

/**
 * Guards for a dashboard served through Cloudflare (see `infra/README.md`).
 *
 * The edge already redirects `http://` to `https://`, so neither the HTTPS guard nor the cache
 * marking should ever matter there. They exist so that the app's own answer does not depend on
 * one zone setting staying switched on.
 */

/**
 * Hono's security headers on every answer: HSTS, `nosniff`, and same-origin opener and
 * resource policies among them.
 *
 * The referrer policy is `same-origin` rather than Hono's `no-referrer`: nothing leaves for
 * another site either way, but under `no-referrer` a browser may send the dashboard's own
 * writes with `Origin: null`, which would defeat any Origin check put in front of them.
 *
 * Framing is refused outright, twice over (`X-Frame-Options` and `frame-ancestors`), so no
 * other site can lay the dashboard under a decoy and have a signed-in operator click Deploy.
 * That directive is the whole Content-Security-Policy on purpose: Mantine writes inline
 * styles, and a fuller policy that got them wrong would break the dashboard.
 *
 * Embedder policy stays off (Hono's default, spelled out): it would block the avatars the
 * dashboard loads from `cdn.discordapp.com`. The opener policy is safe because sign-in is a
 * top-level navigation to Discord and back, and "sign in again" opens a `noopener` tab.
 */
export const dashboardSecureHeaders = secureHeaders({
    xFrameOptions: 'DENY',
    contentSecurityPolicy: { frameAncestors: ["'none'"] },
    referrerPolicy: 'same-origin',
    crossOriginEmbedderPolicy: false,
});

/** `CF-Visitor` is JSON like `{"scheme":"https"}`; this matches the plaintext one. */
const CF_VISITOR_PLAINTEXT = /"scheme"\s*:\s*"http"/i;

/** `X-Forwarded-Proto` may be a comma-separated chain; any `http` hop is plaintext. */
const FORWARDED_PROTO_PLAINTEXT = /(^|,)\s*http\s*(,|$)/i;

/**
 * Refuses a request a proxy says reached it over plain HTTP, so a session cookie is never
 * accepted from a request that crossed the internet unencrypted. A request with neither
 * header came straight to the port (the container's own healthcheck) and is let through.
 */
export const refusePlaintextRequests = createMiddleware<AppEnv>(async (c, next) => {
    const visitor = c.req.header('CF-Visitor') ?? '';
    const forwardedProto = c.req.header('X-Forwarded-Proto') ?? '';
    if (CF_VISITOR_PLAINTEXT.test(visitor) || FORWARDED_PROTO_PLAINTEXT.test(forwardedProto)) {
        return c.text('HTTPS only.', 403);
    }
    await next();
});

/**
 * Marks every API answer as never cacheable. Cloudflare caches by file extension, so JSON
 * under `/api` is not cached today; this keeps one member's guilds, flows and tickets out of
 * any shared cache even if a cache rule is added later.
 */
export const noStoreApiResponses = createMiddleware<AppEnv>(async (c, next) => {
    await next();
    c.header('Cache-Control', 'private, no-store');
});
