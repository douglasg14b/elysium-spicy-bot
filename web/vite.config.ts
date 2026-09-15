import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client build lands in web/dist; the Docker build copies it to dist/web/client
// so the in-process Hono server can serve it. In dev, Vite serves the client and
// proxies /api to the bot's in-process web server (default port 8080).
export default defineConfig({
    plugins: [react()],
    server: {
        // Both ports are declared in `src/environment.ts` (WEB_DEV_CLIENT_PORT and
        // WEB_PORT) so the API server can name this one when somebody opens the
        // API port expecting the dashboard. The defaults are repeated here rather
        // than imported, because this config loads outside the bot's module graph.
        //
        // 5180, not Vite's default 5173: this machine runs other Vite projects,
        // and the default is the one they all take. Two servers on it is not a
        // clean conflict — Windows lets one bind IPv4 and another IPv6, so both
        // "start fine" and the browser picks between them by how it resolves
        // `localhost`. That presents as one browser working and another returning
        // a reset on the same URL, which is a long way from the cause.
        port: Number(process.env.WEB_DEV_CLIENT_PORT) || 5180,
        // Fail rather than silently sliding to the next free port. A dev server on
        // a port nothing printed is how the wrong app ends up being debugged.
        strictPort: true,
        // Bind every interface, so `localhost` reaches this server whichever way
        // the browser resolves it. Left to its default, Vite binds IPv6 only on
        // this machine: Chrome resolves `localhost` to 127.0.0.1 and gets nothing,
        // Firefox resolves it to [::1] and connects — the same URL working in one
        // browser and failing in the other, with no clue pointing at the stack.
        host: true,
        proxy: {
            '/api': {
                // 127.0.0.1, not `localhost`: the bot binds IPv4, and resolving
                // `localhost` to `::1` on a machine where something else holds the
                // IPv6 side is exactly the ambiguity this file is avoiding.
                target: `http://127.0.0.1:${Number(process.env.WEB_PORT) || 8080}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
