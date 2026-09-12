import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client build lands in web/dist; the Docker build copies it to dist/web/client
// so the in-process Hono server can serve it. In dev, Vite serves the client and
// proxies /api to the bot's in-process web server (default port 8080).
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:8080',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
