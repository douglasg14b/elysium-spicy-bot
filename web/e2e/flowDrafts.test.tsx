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
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * Drafts, end to end: unsaved work survives leaving the builder, comes back through the
 * picker, shows other operators' drafts by name, and a live flow's incomplete save lands
 * on the draft and nowhere near the members.
 *
 * Each piece has a suite of its own — the autosave's decisions, the routes against a real
 * database — but only this shows the page's flush, the route and the picker agreeing
 * about one draft.
 */

const OPERATOR: DashboardOperator = { id: '100000000000000003', username: 'e2e-operator' };
const OTHER: DashboardOperator = { id: '100000000000000004', username: 'moxie' };
const FLOW_NAME = 'Doorman';
const ADD_SEND_DM = 'Send DM — drag onto the canvas, or click to add';

/** A member-join DM with something to say: ready. */
const READY: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [
        { id: 'on-join', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
        { id: 'greet', type: ACTION_SEND_DM, position: { x: 0, y: 160 }, data: { message: 'Behave. Or don’t.' } },
    ],
    edges: [{ id: 'join-to-greet', source: 'on-join', target: 'greet' }],
};

interface Seeded {
    readonly client: Client<true>;
    readonly api: SeedApi;
    /** The same API, signed in as {@link OTHER}. */
    readonly otherApi: SeedApi;
    readonly flowId: string;
    readonly flowPath: string;
    /** The flow's `updatedAt` as seeded — the version an operator opening it now loads. */
    readonly loadedAt: string;
}

interface StoredFlow {
    readonly enabled: boolean;
    readonly graph: FlowGraph;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A guild holding one ready flow, switched on when asked. */
async function guildWithFlow(options: { enabled?: boolean } = {}): Promise<Seeded> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild();
    const client = await discord.start();

    const faults: string[] = [];
    const seedAs = (operator: DashboardOperator): SeedApi =>
        createSeedApi(buildDashboardApp({ client, operator, onFault: (fault) => faults.push(fault) }), discord);
    const api = seedAs(OPERATOR);

    const guildPath = `/api/guilds/${guild.id}`;
    const created = await api.send<{ flowId: string; updatedAt: string }>('POST', `${guildPath}/flows`, {
        name: FLOW_NAME,
        graph: READY,
    });
    const flowPath = `${guildPath}/flows/${created.flowId}`;
    const flow = options.enabled
        ? await api.send<{ updatedAt: string }>('PUT', flowPath, { enabled: true })
        : created;
    expect(faults).toEqual([]);

    return { client, api, otherApi: seedAs(OTHER), flowId: created.flowId, flowPath, loadedAt: flow.updatedAt };
}

/** Every card on the canvas — React Flow renders one element per node. */
const cardsOnCanvas = (): number => document.querySelectorAll('.react-flow__node').length;

describe('flow drafts', () => {
    it('keeps unsaved work when the operator leaves, and offers it back on return', async () => {
        const seeded = await guildWithFlow();
        const dashboard = installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        expect(await screen.findByText('All changes saved')).toBeTruthy();
        // Nobody left anything unfinished, so nothing to pick from.
        expect(screen.queryByText('Unfinished business')).toBeNull();

        // An edit, not saved — then straight out, well inside the autosave's pause.
        await user.click(screen.getByTitle(ADD_SEND_DM));
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));

        // Leaving flushed it to the operator's draft.
        await waitFor(() =>
            expect(dashboard.requests).toContainEqual({ method: 'PUT', path: `${seeded.flowPath}/drafts/mine` })
        );
        await waitFor(async () =>
            expect((await seeded.api.send<{ drafts: unknown[] }>('GET', `${seeded.flowPath}/drafts`)).drafts).toHaveLength(1)
        );

        // Back in: the picker names it, and loading it puts the edit back on the canvas.
        await user.click(within(await flowRow(FLOW_NAME)).getByRole('button', { name: 'Edit' }));
        expect(await screen.findByText('Unfinished business')).toBeTruthy();
        expect(screen.getByText('Saved version')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Load Your draft' }));

        await waitFor(() => expect(cardsOnCanvas()).toBe(3));
        expect(screen.getByText(/^Unsaved changes · draft saved \d\d:\d\d$/)).toBeTruthy();

        // And it is real work: saved, it is the flow, and the draft it came from is spent.
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('Saved — 1 problem to fix before this flow can go live.')).toBeTruthy();
        const stored = await seeded.api.send<StoredFlow>('GET', seeded.flowPath);
        expect(stored.graph.nodes).toHaveLength(3);
        expect((await seeded.api.send<{ drafts: unknown[] }>('GET', `${seeded.flowPath}/drafts`)).drafts).toEqual([]);
    });

    it('lists another operator’s draft by name, and loading it does not make it mine', async () => {
        const seeded = await guildWithFlow();
        const theirs: FlowGraph = {
            ...READY,
            nodes: [
                ...READY.nodes,
                { id: 'nag', type: ACTION_SEND_DM, position: { x: 240, y: 160 }, data: { message: 'Read the rules.' } },
            ],
        };
        await seeded.otherApi.send('PUT', `${seeded.flowPath}/drafts/mine`, {
            name: 'Doorman, but pushier',
            graph: theirs,
            baseUpdatedAt: seeded.loadedAt,
        });

        const dashboard = installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        expect(await screen.findByText("@moxie's draft")).toBeTruthy();
        expect(screen.queryByText('Your draft')).toBeNull();
        await user.click(screen.getByRole('button', { name: "Load @moxie's draft" }));

        await waitFor(() => expect(cardsOnCanvas()).toBe(3));
        expect((screen.getByRole('textbox', { name: 'Flow name' }) as HTMLInputElement).value).toBe('Doorman, but pushier');

        // Leaving without touching it: the unmount flush has nothing of mine to send.
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));
        await flowRow(FLOW_NAME);
        expect(dashboard.requests).not.toContainEqual({ method: 'PUT', path: `${seeded.flowPath}/drafts/mine` });
        const drafts = await seeded.api.send<{ drafts: { authorName: string }[] }>('GET', `${seeded.flowPath}/drafts`);
        expect(drafts.drafts.map((draft) => draft.authorName)).toEqual(['moxie']);
    });

    it('saves an incomplete edit of a live flow as a draft only, and the flow stays live', async () => {
        const seeded = await guildWithFlow({ enabled: true });
        installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        expect(await screen.findByText('All changes saved')).toBeTruthy();
        // A DM with nothing to say: incomplete, on a flow members are using.
        await user.click(screen.getByTitle(ADD_SEND_DM));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        expect(
            await screen.findByText(
                'Saved as a draft only — the live flow keeps running the last working version until this problem is fixed.'
            )
        ).toBeTruthy();
        expect(screen.getByText('Draft saved — live flow unchanged')).toBeTruthy();

        // The live flow is exactly what it was.
        const stored = await seeded.api.send<StoredFlow>('GET', seeded.flowPath);
        expect(stored).toMatchObject({ enabled: true, graph: READY });

        // And the list still has it switched on.
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));
        const toggle = within(await flowRow(FLOW_NAME)).getByRole('switch', { name: `Enable ${FLOW_NAME}` });
        expect((toggle as HTMLInputElement).checked).toBe(true);
    });
});
