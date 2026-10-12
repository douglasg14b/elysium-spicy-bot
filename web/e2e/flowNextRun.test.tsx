import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACTION_SEND_MESSAGE } from '../../src/features/flows/blocks/actionSendMessage';
import { TRIGGER_SCHEDULE } from '../../src/features/flows/blocks/triggerSchedule';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { TestDiscord, type ServerGuild } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * The next-run countdown on a Schedule card, end to end: the real routes, the real
 * reconcile after every save, and the real builder.
 *
 * The card shows the saved schedule's next time, swaps to "worked out when you save" the
 * moment its node is edited, and comes back once the save lands; a node nothing schedules
 * shows nothing; switching the flow off asks again and the countdown goes. And neither
 * the countdown nor the zone line is ever in the way: if their fetches fail, the builder
 * opens all the same.
 */

const OPERATOR = { id: '100000000000000003', username: 'e2e-operator' };
const COUNTDOWN = /^Next run (in |any moment)/;
const AFTER_SAVE = 'Next run is worked out when you save';

interface ScheduledFlow {
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly api: SeedApi;
    readonly flowId: string;
    readonly flowPath: string;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A switched-on flow: every day at 9:00 AM, post in #dungeon. */
async function guildWithScheduledFlow(): Promise<ScheduledFlow> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild();
    const channel = guild.createTextChannel({ name: 'dungeon' });
    const client = await discord.start();

    const api = createSeedApi(buildDashboardApp({ client, operator: OPERATOR, onFault: () => undefined }), discord);
    const guildPath = `/api/guilds/${guild.id}`;
    const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: 'Morning roll call' });
    const flowPath = `${guildPath}/flows/${flow.flowId}`;

    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'nine', type: TRIGGER_SCHEDULE, position: { x: 0, y: 0 }, data: { repeat: 'daily', time: '09:00' } },
            {
                id: 'post',
                type: ACTION_SEND_MESSAGE,
                position: { x: 300, y: 0 },
                data: { channelId: channel.id, message: 'Rise and grind, brats.' },
            },
        ],
        edges: [{ id: 'nine-post', source: 'nine', target: 'post' }],
    };
    await api.send('PUT', flowPath, { graph });
    await api.send('PUT', flowPath, { enabled: true });

    return { client, guild, api, flowId: flow.flowId, flowPath };
}

function countdowns(): HTMLElement[] {
    return screen.queryAllByText(COUNTDOWN);
}

/**
 * Select a card by clicking its summary line. A bare click rather than user-event's full
 * press: the press's mousedown reaches React Flow's drag handler, which reads a window
 * jsdom does not hand it.
 */
function selectCard(summary: string): void {
    fireEvent.click(screen.getByText(summary));
}

describe('the next-run countdown on a card', () => {
    it('shows for the saved schedule, swaps after an edit, and comes back once saved', async () => {
        const scheduled = await guildWithScheduledFlow();
        installDashboardApi(scheduled.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${scheduled.flowId}`);

        expect(await screen.findByText('Every day at 9:00 AM')).toBeTruthy();
        // On the Schedule card only: Send Message has no next run.
        await waitFor(() => expect(countdowns()).toHaveLength(1));

        // Selecting it shows the time on the 12-hour clock, and asks for a zone.
        selectCard('Every day at 9:00 AM');
        expect((await screen.findByRole('textbox', { name: 'Time hour' }) as HTMLInputElement).value).toBe('9');
        expect(await screen.findByText(/Not set: using Pacific Time until you pick one in/)).toBeTruthy();

        await user.click(screen.getByText('PM'));
        expect(await screen.findByText('Every day at 9:00 PM')).toBeTruthy();
        expect(await screen.findByText(AFTER_SAVE)).toBeTruthy();
        expect(countdowns()).toHaveLength(0);

        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(countdowns()).toHaveLength(1));
        expect(screen.queryByText(AFTER_SAVE)).toBeNull();
    });

    it('asks again after the flow is switched off, and the countdown goes', async () => {
        const scheduled = await guildWithScheduledFlow();
        const dashboard = installDashboardApi(scheduled.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${scheduled.flowId}`);
        await waitFor(() => expect(countdowns()).toHaveLength(1));
        const askedBefore = dashboard.requests.filter((request) => request.path.endsWith('/next-runs')).length;

        await user.click(screen.getByRole('switch', { name: 'Enabled' }));

        await waitFor(() => expect(countdowns()).toHaveLength(0));
        expect(dashboard.requests.filter((request) => request.path.endsWith('/next-runs')).length).toBe(askedBefore + 1);
    });

    it('never stands in the way: a failed countdown or zone fetch still opens the builder', async () => {
        const scheduled = await guildWithScheduledFlow();
        installDashboardApi(scheduled.client, OPERATOR);
        // Behind the real API: the two reads fail, and everything else answers as usual.
        const answer = globalThis.fetch;
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            // The SDK sends a `Request` with no init, whose `toString()` is no URL.
            const url = input instanceof Request ? input.url : input.toString();
            const path = new URL(url, 'http://dashboard.test').pathname;
            if (path.endsWith('/next-runs') || path.endsWith('/settings')) {
                return new Response(JSON.stringify({ error: 'The dungeon is closed.' }), { status: 500 });
            }
            return answer(input, init);
        });
        const { user } = renderDashboard(`/flows/${scheduled.flowId}`);

        expect(await screen.findByText('Every day at 9:00 AM')).toBeTruthy();
        expect(screen.getByText('All changes saved')).toBeTruthy();
        expect(countdowns()).toHaveLength(0);

        selectCard('Every day at 9:00 AM');
        const inspector = await screen.findByRole('textbox', { name: 'Time hour' });
        expect((inspector as HTMLInputElement).value).toBe('9');
        expect(screen.queryByText(/Server time|Not set/)).toBeNull();
        expect(within(document.body).queryByText(/The dungeon is closed/)).toBeNull();
    });
});
