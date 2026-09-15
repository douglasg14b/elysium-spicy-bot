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
        port: Number(process.env.WEB_DEV_CLIENT_PORT) || 5173,
        proxy: {
            '/api': {
                target: `http://localhost:${Number(process.env.WEB_PORT) || 8080}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
