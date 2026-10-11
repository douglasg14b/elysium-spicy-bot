import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_KICK_MEMBER } from '../../src/features/flows/blocks/actionKickMember';
import { TRIGGER_MEMBER_LEAVE } from '../../src/features/flows/blocks/triggerMemberLeave';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * A flow that would start itself, switched on from the flows list: the server refuses it
 * with the loop spelled out, and the page shows that sentence and puts the switch back.
 *
 * Member Leaves → Kick Member is the smallest such flow — a kick is a departure, so the
 * flow's own action fires its own trigger — and needs no ticketing set up. Nothing on its
 * canvas is wrong, so the refusal carries no issues and the row's issue chip must not
 * change: the loop is a conflict between runs, not a problem on a node.
 */

const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const FLOW_NAME = 'Bouncer';

interface StoredFlow {
    readonly enabled: boolean;
    readonly issues: readonly unknown[];
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

describe('switching on a flow that would start itself', () => {
    it('is refused from the list with the loop named, and the switch goes back', async () => {
        const discord = new TestDiscord();
        running.push(discord);
        const guild = discord.createGuild();
        const client = await discord.start();

        const faults: string[] = [];
        const api = createSeedApi(
            buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }),
            discord
        );
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'leaves', type: TRIGGER_MEMBER_LEAVE, position: { x: 0, y: 0 }, data: {} },
                { id: 'kick', type: ACTION_KICK_MEMBER, position: { x: 0, y: 160 }, data: {} },
            ],
            edges: [{ id: 'leaves-kick', source: 'leaves', target: 'kick' }],
        };
        const guildPath = `/api/guilds/${guild.id}`;
        const flow = await api.send<{ flowId: string } & StoredFlow>('POST', `${guildPath}/flows`, {
            name: FLOW_NAME,
            graph,
        });
        const flowPath = `${guildPath}/flows/${flow.flowId}`;
        // Ready: nothing on the canvas is wrong, which is what makes this a loop refusal.
        expect(flow.issues).toEqual([]);
        expect(faults).toEqual([]);

        const dashboard = installDashboardApi(client, OPERATOR);
        const { user } = renderDashboard('/flows');
        const row = await flowRow(FLOW_NAME);
        expect(within(row).queryByText('Needs fixes')).toBeNull();

        const toggle = within(row).getByRole('switch', { name: `Enable ${FLOW_NAME}` });
        await user.click(toggle);

        expect(
            await screen.findByText(
                'That would make this flow set itself off in a loop: "Bouncer" (Kick Member) starts "Bouncer" again. ' +
                    "Change it so it doesn't."
            )
        ).toBeTruthy();
        await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
        expect(dashboard.requests).toContainEqual({ method: 'PUT', path: flowPath });
        // The chip is the canvas's count, and the canvas is fine: still none.
        expect(within(row).queryByText('Needs fixes')).toBeNull();
        expect((await api.send<StoredFlow>('GET', flowPath)).enabled).toBe(false);
    });
});
