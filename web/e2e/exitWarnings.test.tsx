import { screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_SET_VARIABLE } from '../../src/features/flows/blocks/actionSetVariable';
import { ACTION_WAIT_FOR_EVENT } from '../../src/features/flows/blocks/actionWaitForEvent';
import { CONDITION_TIME_SINCE } from '../../src/features/flows/blocks/conditionTimeSince';
import { TRIGGER_MEMBER_JOIN } from '../../src/features/flows/blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * The builder's warning about a forgotten exit, end to end: from what a shipped block
 * declares, through `GET /api/nodes`, onto the card.
 *
 * Its unit suite drives the rule with hand-written descriptors, which cannot show the
 * served manifest and the card agreeing. Here a real Time Since leaves No record
 * unconnected and its card says so — unless its source only reaches No record in a rare
 * edge — while a real Wait for Event's "Timed out" is named only once the wait has a time
 * limit — without one, no run can take it.
 */

const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const NO_RECORD_WARNING = "No record isn't connected — runs that land here just stop.";
const TIMED_OUT_WARNING = "Timed out isn't connected — runs that land here fail.";

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/**
 * Save a flow — join -> Time Since (Yes wired, No record not) -> wait for a rejoin ->
 * stamp — and open it in the builder. `waitData` and `sinceData` are merged into the
 * wait's and the Time Since's config, so a test can give the wait a time limit or pick
 * another source.
 */
async function openFlow(waitData: Record<string, unknown>, sinceData: Record<string, unknown> = {}): Promise<void> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild();
    const client = await discord.start();

    const faults: string[] = [];
    const api = createSeedApi(
        buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }),
        discord
    );
    const guildPath = `/api/guilds/${guild.id}`;
    const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: 'Long time no see' });

    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: 'since',
                type: CONDITION_TIME_SINCE,
                position: { x: 0, y: 160 },
                data: { source: 'memberMessage', comparison: 'atLeast', durationMs: 86_400_000, ...sinceData },
            },
            {
                id: 'rejoin',
                type: ACTION_WAIT_FOR_EVENT,
                position: { x: 0, y: 320 },
                data: { eventKind: 'memberJoin', timeoutCountsFrom: 'waitStart', ...waitData },
            },
            {
                id: 'stamp',
                type: ACTION_SET_VARIABLE,
                position: { x: 0, y: 480 },
                data: { variableName: 'seenAt', valueType: 'time' },
            },
        ],
        edges: [
            { id: 'e1', source: 'joined', target: 'since' },
            { id: 'e2', source: 'since', sourceHandle: 'true', target: 'rejoin' },
            { id: 'e3', source: 'rejoin', target: 'stamp' },
        ],
    };
    // Sound and complete, so no red on any card hides the amber.
    const saved = await api.send<{ issues: readonly unknown[] }>('PUT', `${guildPath}/flows/${flow.flowId}`, {
        graph,
    });
    expect(saved.issues).toEqual([]);
    expect(faults).toEqual([]);

    installDashboardApi(client, OPERATOR);
    renderDashboard(`/flows/${flow.flowId}`);
}

describe('an exit worth a warning, left unconnected', () => {
    it('is named on the Time Since card, and an unlimited wait’s timeout is not', async () => {
        await openFlow({});

        // Nothing is selected, so this is the card speaking, and only the one card.
        expect(await screen.findByText(NO_RECORD_WARNING)).toBeTruthy();
        expect(screen.getAllByText(NO_RECORD_WARNING)).toHaveLength(1);
        expect(screen.queryByText(TIMED_OUT_WARNING)).toBeNull();
    });

    it('names the wait’s timeout once it has a time limit, as a failure', async () => {
        await openFlow({ timeoutMs: 3_600_000 });

        expect(await screen.findByText(TIMED_OUT_WARNING)).toBeTruthy();
        expect(screen.getAllByText(NO_RECORD_WARNING)).toHaveLength(1);
    });

    it('is not named on a Time Since measuring from the run’s start, where No record is a rare edge', async () => {
        // The wait has a limit so its timeout warning proves the cards have rendered
        // their advisories before the absence below is read.
        await openFlow({ timeoutMs: 3_600_000 }, { source: 'runStarted' });

        expect(await screen.findByText(TIMED_OUT_WARNING)).toBeTruthy();
        expect(screen.queryByText(NO_RECORD_WARNING)).toBeNull();
    });
});
