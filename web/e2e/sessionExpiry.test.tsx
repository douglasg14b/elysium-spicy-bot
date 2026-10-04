import { screen, waitFor, within } from '@testing-library/react';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_SEND_DM } from '../../src/features/flows/blocks/actionSendDM';
import { TRIGGER_MEMBER_JOIN } from '../../src/features/flows/blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp, type DashboardOperator } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * A session running out in the middle of an edit, end to end: the Flow Builder's draft
 * autosave is refused, the "sign in again" panel goes over a canvas left exactly as it
 * was, and once the operator is back the held write lands and Save works — nothing lost.
 *
 * The gate's own sequencing is `web/src/auth/__tests__/sessionGate.test.ts` and the app's
 * handling of it `sessionExpiry.test.tsx` beside it; only this runs the builder's real
 * autosave through the real routes while the session is gone.
 */

const OPERATOR: DashboardOperator = { id: '100000000000000005', username: 'e2e-operator' };
const FLOW_NAME = 'Doorman';
const ADD_SEND_DM = 'Send DM — drag onto the canvas, or click to add';
const PANEL_TITLE = 'Your session safeworded out';

/** A member-join DM with something to say: ready. */
const READY: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [
        { id: 'on-join', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
        { id: 'greet', type: ACTION_SEND_DM, position: { x: 0, y: 160 }, data: { message: 'Behave. Or don’t.' } },
    ],
    edges: [{ id: 'join-to-greet', source: 'on-join', target: 'greet' }],
};

/** What the server holds for a flow or a draft of it, as far as this test reads it. */
interface StoredGraph {
    readonly name: string;
    readonly graph: FlowGraph;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A guild holding one ready flow, and the API to read it back with. */
async function guildWithFlow(): Promise<{ readonly client: Client<true>; readonly api: SeedApi; readonly flowId: string; readonly flowPath: string }> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild();
    const client = await discord.start();

    const faults: string[] = [];
    const api = createSeedApi(buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }), discord);
    const created = await api.send<{ flowId: string }>('POST', `/api/guilds/${guild.id}/flows`, { name: FLOW_NAME, graph: READY });
    expect(faults).toEqual([]);

    return { client, api, flowId: created.flowId, flowPath: `/api/guilds/${guild.id}/flows/${created.flowId}` };
}

/** Every card on the canvas — React Flow renders one element per node. */
const cardsOnCanvas = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('.react-flow__node');

describe('a session that runs out mid-edit', () => {
    it('keeps the canvas under the panel, and the draft and the Save land once the operator is back', async () => {
        const seeded = await guildWithFlow();
        const dashboard = installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);
        expect(await screen.findByText('All changes saved')).toBeTruthy();

        dashboard.expireSession();
        // A card added and selected — so a Backspace that reached the canvas would delete
        // it — then the name edited, and typing paused.
        await user.click(screen.getByTitle(ADD_SEND_DM));
        await waitFor(() => expect(cardsOnCanvas()).toHaveLength(3));
        const added = [...cardsOnCanvas()].at(-1);
        if (!added) throw new Error('The added card is not on the canvas.');
        // Selected from the keyboard, as React Flow allows: a pointer press runs d3-drag,
        // which jsdom's events cannot carry.
        added.focus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(added.classList.contains('selected')).toBe(true));
        const nameBox = screen.getByRole('textbox', { name: 'Flow name' }) as HTMLInputElement;
        await user.type(nameBox, ', after hours');

        // The draft autosave fires once typing pauses, is refused, and is held.
        const panel = await screen.findByRole('dialog', { name: PANEL_TITLE });
        expect(nameBox.value).toBe('Doorman, after hours');
        expect(panel.contains(document.activeElement)).toBe(true);
        await user.keyboard('{Backspace}');
        expect(cardsOnCanvas()).toHaveLength(3);
        expect(screen.getByText(/^Unsaved changes/)).toBeTruthy();
        expect((await seeded.api.send<{ drafts: StoredGraph[] }>('GET', `${seeded.flowPath}/drafts`)).drafts).toEqual([]);

        dashboard.restoreSession();
        await user.click(within(panel).getByRole('button', { name: "I've signed in" }));

        await waitFor(() => expect(screen.queryByRole('dialog', { name: PANEL_TITLE })).toBeNull());
        // Back where the operator was typing.
        await waitFor(() => expect(document.activeElement).toBe(nameBox));
        // The held write went out as it was: the whole canvas, the new name included.
        await waitFor(async () => {
            const { drafts } = await seeded.api.send<{ drafts: StoredGraph[] }>('GET', `${seeded.flowPath}/drafts`);
            expect(drafts.map((draft) => ({ name: draft.name, nodes: draft.graph.nodes.length }))).toEqual([
                { name: 'Doorman, after hours', nodes: 3 },
            ]);
        });
        expect(await screen.findByText(/^Unsaved changes · draft saved \d\d:\d\d$/)).toBeTruthy();
        expect(cardsOnCanvas()).toHaveLength(3);

        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('Saved — 1 problem to fix before this flow can go live.')).toBeTruthy();
        const stored = await seeded.api.send<StoredGraph>('GET', seeded.flowPath);
        expect(stored.name).toBe('Doorman, after hours');
        expect(stored.graph.nodes).toHaveLength(3);
    });
});
