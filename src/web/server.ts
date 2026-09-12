import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { WEB_ENABLED, WEB_PORT, getMissingWebEnv } from '../environment';
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
 */
function resolveClientDir(): string | null {
    const candidates = [
        resolve(__dirname, 'client'), // dist/web/client (production)
        resolve(__dirname, '../../web/dist'), // repo web/dist (fallback)
    ];
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
        app.get('/', (c) =>
            c.text('SpicyBot web server is running. The client build was not found (dev mode uses the Vite server).')
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
