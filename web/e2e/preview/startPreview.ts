import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { DISCORD_CLIENT } from '../../../src/discordClient';
import { TestDiscord } from '../../../src/shared/__tests__/support/testDiscord';
import { bootBotForDashboard } from '../support/bootBot';
import { buildDashboardApp } from '../support/dashboardApp';
import { PREVIEW_PAGES_PATH, type PreviewPage } from './previewPages';
import { createSeedApi } from './scenario/seedApi';
import { seedScenario } from './scenario/seedScenario';

export interface PreviewPorts {
    readonly apiPort: number;
    readonly webPort: number;
}

/**
 * Boot the bot's side the way `bot.ts` does, minus the gateway, seed one guild, and serve.
 *
 * `DISCORD_CLIENT` itself is what TestDiscord drives, not a second client, so the code
 * paths that read the singleton rather than a route's guild — the warnings channel check,
 * posting a trigger button — work here as they do in production.
 *
 * One consequence: the singleton subscribes to message events, which TestDiscord does not
 * model, so any message the bot sends from here faults by design. Dashboard ticket actions
 * post one, so they fault in the preview; `web/e2e/ticketActions.test.tsx` covers them.
 */
export async function startPreview({ apiPort, webPort }: PreviewPorts): Promise<void> {
    await bootBotForDashboard();

    const discord = new TestDiscord();
    const faultsReported = { count: 0 };
    /*
     * A preview never ends, so nothing would ever rethrow a fault the way a test does.
     * Each is printed as it happens instead, loudly, because a page showing an error
     * message is often the only other sign — and it reads as a product bug.
     */
    const reportFault = (fault: string): void => {
        console.error(`\n[preview fault] ${fault}\n`);
    };
    const reportDiscordFaults = (): void => {
        for (const fault of discord.faults.slice(faultsReported.count)) {
            reportFault(`TestDiscord: ${fault.message}`);
        }
        faultsReported.count = discord.faults.length;
    };

    const scenarioGuild = seedScenario.discord(discord);
    const client = await discord.start({ client: DISCORD_CLIENT });
    const app = buildDashboardApp({ client, operator: scenarioGuild.operator, onFault: reportFault });

    const pages: PreviewPage[] = await seedScenario.data({
        discord,
        guild: scenarioGuild,
        clientGuild: discord.clientGuild(scenarioGuild.guild),
        api: createSeedApi(app, discord),
    });
    reportDiscordFaults();

    serve({
        hostname: '127.0.0.1',
        port: apiPort,
        fetch: async (request) => {
            if (new URL(request.url).pathname === PREVIEW_PAGES_PATH) {
                return Response.json({ pages });
            }
            const response = await app.fetch(request);
            // What real Discord sends back for the bot's own writes arrives after the
            // response, and a preview has no test to say when to settle it.
            discord.flushGateway();
            reportDiscordFaults();
            return response;
        },
    });

    const vite = await createServer({
        configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
        root: fileURLToPath(new URL('../..', import.meta.url)),
        // One cache per port, so several previews, and `pnpm dev`, can run at once
        // without re-optimising each other's dependencies mid-page.
        cacheDir: fileURLToPath(new URL(`../../node_modules/.vite-preview-${webPort}`, import.meta.url)),
    });
    await vite.listen();

    const base = `http://localhost:${webPort}`;
    console.log(`\nDashboard preview on ${base} (API on http://127.0.0.1:${apiPort}), signed in as ${scenarioGuild.operator.username}.`);
    console.log('Seeded pages:');
    for (const page of pages) console.log(`  ${base}${page.path}  — ${page.name}: ${page.note}`);
}
