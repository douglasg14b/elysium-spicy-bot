import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { WEB_DEV_CLIENT_PORT, WEB_ENABLED, WEB_PORT, getMissingWebEnv } from '../environment';
import { registerApiRoutes } from './api';
import type { AppEnv } from './types';

/**
 * In-process web server for the dashboard. See docs/adr/0001-web-server-in-bot-process.md.
 *
 * Starting it is opt-in: {@link startWebServer} is a no-op unless the required web
 * env vars are present ({@link WEB_ENABLED}). Bot-only deployments are unaffected.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the built React app directory. In dev (`tsx`) this file runs from `src/web`,
 * and there is no build — Vite serves the client separately and proxies `/api` here.
 * In production (`node dist/web/server.js`) the client build is copied to `dist/web/client`.
 *
 * **`web/dist` is deliberately not a candidate in dev.** It used to be, and the
 * result was a trap: `web/dist` is whatever `build:web` last produced, and nothing
 * rebuilds it, so this server would happily serve a months-old bundle on the port
 * an author was already using for the API. The palette is fetched from `/api/nodes`
 * at runtime while the controls are compiled in, so that stale bundle listed
 * today's blocks and could not draw a control added after its build date —
 * presenting as a bug in the block rather than as an old bundle. The build is never
 * *labelled* stale, so there is no version to compare and no honest way to serve
 * it. Not serving it is the only answer that cannot mislead.
 *
 * In dev the client is Vite's job, on its own port. `pnpm dev` starts both.
 */
function resolveClientDir(): string | null {
    // `tsx` sets this in every dev script; a built server runs under plain node.
    const isDev = process.env.TSX === 'true';
    const candidates = isDev ? [] : [resolve(__dirname, 'client')];
    return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}

let server: ServerType | null = null;

export function buildApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // JSON API (auth, guilds, config, flows) lives under /api.
    registerApiRoutes(app);

    // Serve the built SPA + client-side routing fallback, if a build exists.
    const clientDir = resolveClientDir();
    if (clientDir) {
        // serveStatic paths are relative to cwd, so pass a cwd-relative root.
        const root = './' + resolve(clientDir).replace(process.cwd(), '').replace(/^[\\/]/, '').replace(/\\/g, '/');
        app.use('/*', serveStatic({ root }));
        // SPA fallback: any non-/api, non-file route returns index.html.
        app.get('/*', serveStatic({ path: join(root, 'index.html') }));
    } else {
        // Names the port rather than saying "use Vite", because the whole failure
        // this replaces was an author on the right machine looking at the wrong
        // port and having no way to tell.
        app.get('/', (c) =>
            c.text(
                'SpicyBot API is running here, but the dashboard is not served from this port in development.\n' +
                    `Open http://localhost:${WEB_DEV_CLIENT_PORT} instead — that is Vite, and it proxies /api back here.\n` +
                    'If nothing is listening there, run `pnpm dev` (it starts the bot and the dashboard together).'
            )
        );
    }

    return app;
}

/**
 * Start the in-process web server if configured. Returns true if it started.
 * Never throws for missing config — it logs and returns false.
 */
export function startWebServer(): boolean {
    if (!WEB_ENABLED) {
        const missing = getMissingWebEnv();
        console.log(
            `🌐 Web dashboard disabled — missing env: ${missing.join(', ')}. ` +
                `Set these to enable it (see docs/adr/0001-web-server-in-bot-process.md).`
        );
        return false;
    }

    const app = buildApp();
    server = serve({ fetch: app.fetch, port: WEB_PORT }, (info) => {
        console.log(`🌐 Web dashboard listening on http://localhost:${info.port}`);
    });
    return true;
}

export function stopWebServer(): void {
    server?.close();
    server = null;
}
