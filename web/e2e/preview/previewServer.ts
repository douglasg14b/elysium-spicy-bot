import { parseArgs } from 'node:util';

/**
 * The dashboard, running in a real browser against a fake Discord: `pnpm preview:dashboard`.
 *
 * The bot's API routes, engines and database are the production modules. Discord is
 * TestDiscord, seeded with one deliberately awkward guild (see `scenario/`), and sessions
 * are replaced by one signed-in operator. Vite serves the dashboard and proxies `/api`
 * here, the way `pnpm dev` does. Nothing reaches Discord, and nothing is persisted: the
 * database is in memory and is seeded fresh on every start.
 *
 * For looking at pages, by eye or through `shoot.ts`. It is not a test: nothing here
 * asserts. What an e2e test would catch belongs in `web/e2e`.
 *
 *   pnpm preview:dashboard [--api-port 8190] [--web-port 5190]
 *
 * The ports default away from `pnpm dev`'s, so both can run at once.
 */

const { values } = parseArgs({
    options: {
        'api-port': { type: 'string', default: '8190' },
        'web-port': { type: 'string', default: '5190' },
    },
});

/*
 * Assigned, not defaulted, and before any bot module loads: `environment.ts` reads these
 * at import time, and a real token or database path in the caller's shell must never
 * reach a process that seeds fake data. Static imports would run before these lines,
 * which is why everything else is imported dynamically below.
 */
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.DISCORD_APP_ID = '000000000000000000';
process.env.DISCORD_BOT_TOKEN = 'preview-not-a-real-token';
process.env.OPENAI_API_KEY = 'sk-preview-not-a-real-key';
process.env.OPENROUTER_API_KEY = 'sk-preview-not-a-real-key';
// Read by `web/vite.config.ts` for its port and its `/api` proxy target.
process.env.WEB_PORT = values['api-port'];
process.env.WEB_DEV_CLIENT_PORT = values['web-port'];

const { startPreview } = await import('./startPreview');
await startPreview({ apiPort: Number(values['api-port']), webPort: Number(values['web-port']) });
