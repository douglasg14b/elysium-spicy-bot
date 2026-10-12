import type { Client } from 'discord.js';
import { onTestFinished, vi } from 'vitest';
import { buildDashboardApp, type DashboardOperator } from './dashboardApp';

/** A request the dashboard sent, as the bot's API received it. */
export interface DashboardRequest {
    readonly method: string;
    /** Pathname plus search. */
    readonly path: string;
}

export interface DashboardApi {
    /** Every request the dashboard sent, in order. */
    readonly requests: readonly DashboardRequest[];
    /** The operator's session runs out: `/me` and every guarded route answer 401 until restored. */
    readonly expireSession: () => void;
    /** The operator has signed in again, as the same person. */
    readonly restoreSession: () => void;
}

/** Signed in when a test does not say who. Not a guild member; a test that needs one passes it. */
const DEFAULT_OPERATOR: DashboardOperator = { id: '100000000000000001', username: 'e2e-operator' };

/**
 * Serve the dashboard's `fetch` from the bot's real API routes, for one test.
 *
 * The routes, the engines behind them, the database and discord.js are all the
 * production modules; {@link buildDashboardApp} says what is replaced. The network is too:
 * `fetch` is handed to Hono's `app.request` directly, so no port is bound.
 *
 * Every fault the app reports is recorded and rethrown when the test finishes, because
 * the dashboard turns each into a quiet error message and a test could otherwise pass
 * for the wrong reason. This is the rule `installFakeApi` and TestDiscord follow too.
 */
export function installDashboardApi(client: Client<true>, operator: DashboardOperator = DEFAULT_OPERATOR): DashboardApi {
    const requests: DashboardRequest[] = [];
    const faults: string[] = [];
    let sessionLive = true;
    const app = buildDashboardApp({
        client,
        operator,
        onFault: (fault) => faults.push(fault),
        sessionLive: () => sessionLive,
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // As a `Request`, because the generated SDK calls `fetch(request)` with no init
        // while a plain call passes a path and an init. Hono routes on the pathname, so the
        // page origin the URL was resolved against does not matter.
        const sent = new Request(input, init);
        const url = new URL(sent.url);
        requests.push({ method: sent.method.toUpperCase(), path: `${url.pathname}${url.search}` });
        return app.request(sent);
    });

    onTestFinished(() => {
        vi.unstubAllGlobals();
        if (faults.length > 0) {
            throw new Error(`The dashboard hit something the API does not answer:\n  ${faults.join('\n  ')}`);
        }
    });

    return {
        requests,
        expireSession: () => {
            sessionLive = false;
        },
        restoreSession: () => {
            sessionLive = true;
        },
    };
}
