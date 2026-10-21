import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './types';

/**
 * Guards for a dashboard served through Cloudflare (see `infra/README.md`).
 *
 * The edge already redirects `http://` to `https://`, so neither of these should ever fire
 * there. They exist so that the app's own answer does not depend on one zone setting staying
 * switched on.
 */

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
