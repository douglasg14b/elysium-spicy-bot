import { screen, waitFor, within } from '@testing-library/react';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
 * Leaving the builder with unsaved work: every way out asks, and each answer does what it
 * says — to the flow, to my draft, and to nobody else's.
 *
 * The rule itself is `leaveGuard.test.ts`; this is the router, the page and the API
 * agreeing about it.
 */

const OPERATOR: DashboardOperator = { id: '100000000000000005', username: 'e2e-operator' };
const OTHER: DashboardOperator = { id: '100000000000000006', username: 'moxie' };
const FLOW_NAME = 'Doorman';
const ADD_SEND_DM = 'Send DM — drag onto the canvas, or click to add';
const PROMPT = `Leave "${FLOW_NAME}" with unsaved changes?`;

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
    readonly loadedAt: string;
}

interface StoredFlow {
    readonly enabled: boolean;
    readonly graph: FlowGraph;
}

interface ListedDraft {
    readonly draftId: number;
    readonly authorName: string;
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

const draftsOf = async (seeded: Seeded): Promise<ListedDraft[]> =>
    (await seeded.api.send<{ drafts: ListedDraft[] }>('GET', `${seeded.flowPath}/drafts`)).drafts;

/**
 * Answer one request differently, after `installDashboardApi` has set up the rest. `serve`
 * sends it on to the API as normal.
 */
function interceptRequest(
    method: string,
    path: string,
    answer: (serve: () => Promise<Response>) => Promise<Response>
): void {
    const served = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://dashboard.test');
        const serve = (): Promise<Response> => served(input, init);
        return (init?.method ?? 'GET').toUpperCase() === method && url.pathname === path ? answer(serve) : serve();
    });
}

/**
 * Drop the connection for one request. A network failure rather than a refusal, because it
 * is the one no route can be made to give on demand.
 */
function dropConnectionFor(method: string, path: string): void {
    interceptRequest(method, path, () => Promise.reject(new TypeError('Failed to fetch')));
}

/** Hold one request until the returned function lets it through. */
function holdRequest(method: string, path: string): () => void {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    interceptRequest(method, path, async (serve) => {
        await released;
        return serve();
    });
    return () => release();
}

/** Open the builder clean, drop in an unsaved DM, and try to leave by the back button. */
async function editThenLeave(seeded: Seeded) {
    const rendered = renderDashboard(`/flows/${seeded.flowId}`);
    expect(await screen.findByText('All changes saved')).toBeTruthy();
    await rendered.user.click(screen.getByTitle(ADD_SEND_DM));
    await rendered.user.click(screen.getByRole('button', { name: 'Back to flows' }));
    const prompt = await screen.findByRole('dialog', { name: PROMPT });
    return { ...rendered, prompt };
}

describe('leaving the flow builder', () => {
    it('leaves a clean canvas without asking', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        expect(await screen.findByText('All changes saved')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));

        await flowRow(FLOW_NAME);
        expect(screen.queryByRole('dialog', { name: PROMPT })).toBeNull();
    });

    it('holds Back on an edit, and Stay keeps the edit on the canvas', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        const { user, router, prompt } = await editThenLeave(seeded);

        await user.click(within(prompt).getByRole('button', { name: 'Stay' }));

        await waitFor(() => expect(screen.queryByRole('dialog', { name: PROMPT })).toBeNull());
        expect(router.state.location.pathname).toBe(`/flows/${seeded.flowId}`);
        expect(cardsOnCanvas()).toBe(3);
        expect(screen.getByText(/^Unsaved changes/)).toBeTruthy();
    });

    it('saves from the prompt, and lands on the list with the edit stored', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        const { user, prompt } = await editThenLeave(seeded);

        await user.click(within(prompt).getByRole('button', { name: 'Save' }));

        await flowRow(FLOW_NAME);
        expect(await screen.findByText('Saved — 1 problem to fix before this flow can go live.')).toBeTruthy();
        expect((await seeded.api.send<StoredFlow>('GET', seeded.flowPath)).graph.nodes).toHaveLength(3);
        expect(await draftsOf(seeded)).toEqual([]);
    });

    it('saves a live flow from the prompt as a draft only, says so, and still leaves', async () => {
        const seeded = await guildWithFlow({ enabled: true });
        installDashboardApi(seeded.client, OPERATOR);
        const { user, prompt } = await editThenLeave(seeded);

        await user.click(within(prompt).getByRole('button', { name: 'Save' }));

        await flowRow(FLOW_NAME);
        expect(
            await screen.findByText(
                'Saved as a draft only — the live flow keeps running the last working version until this problem is fixed.'
            )
        ).toBeTruthy();
        expect(await seeded.api.send<StoredFlow>('GET', seeded.flowPath)).toMatchObject({ enabled: true, graph: READY });
        expect((await draftsOf(seeded)).map((draft) => draft.authorName)).toEqual([OPERATOR.username]);
    });

    it('waits for a Save already on its way, then leaves without asking anything more', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        const release = holdRequest('PUT', seeded.flowPath);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        expect(await screen.findByText('All changes saved')).toBeTruthy();
        await user.click(screen.getByTitle(ADD_SEND_DM));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));

        // Every answer would race the save for the draft, so none is offered until it lands.
        const prompt = await screen.findByRole('dialog', { name: PROMPT });
        for (const answer of ['Discard changes', 'Stay', 'Keep as draft', 'Save']) {
            expect((within(prompt).getByRole('button', { name: answer }) as HTMLButtonElement).disabled).toBe(true);
        }

        release();
        await flowRow(FLOW_NAME);
        expect((await seeded.api.send<StoredFlow>('GET', seeded.flowPath)).graph.nodes).toHaveLength(3);
        expect(await draftsOf(seeded)).toEqual([]);
    });

    it('stays put, edit and all, when the save from the prompt fails', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        dropConnectionFor('PUT', seeded.flowPath);
        const { user, router, prompt } = await editThenLeave(seeded);

        await user.click(within(prompt).getByRole('button', { name: 'Save' }));

        expect(await screen.findByText("Couldn't save. Try again in a second.")).toBeTruthy();
        await waitFor(() => expect(screen.queryByRole('dialog', { name: PROMPT })).toBeNull());
        expect(router.state.location.pathname).toBe(`/flows/${seeded.flowId}`);
        expect(cardsOnCanvas()).toBe(3);
        expect((await seeded.api.send<StoredFlow>('GET', seeded.flowPath)).graph).toEqual(READY);
    });

    it('stays put when the draft cannot be kept', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        dropConnectionFor('PUT', `${seeded.flowPath}/drafts/mine`);
        const { user, router, prompt } = await editThenLeave(seeded);

        await user.click(within(prompt).getByRole('button', { name: 'Keep as draft' }));

        expect(await screen.findByText("Couldn't keep your draft")).toBeTruthy();
        await waitFor(() => expect(screen.queryByRole('dialog', { name: PROMPT })).toBeNull());
        expect(router.state.location.pathname).toBe(`/flows/${seeded.flowId}`);
        expect(cardsOnCanvas()).toBe(3);
        expect(await draftsOf(seeded)).toEqual([]);
    });

    it('keeps the edit as my draft, and the picker offers it back', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        const { user, prompt } = await editThenLeave(seeded);

        await user.click(within(prompt).getByRole('button', { name: 'Keep as draft' }));

        await flowRow(FLOW_NAME);
        expect((await seeded.api.send<StoredFlow>('GET', seeded.flowPath)).graph).toEqual(READY);
        expect((await draftsOf(seeded)).map((draft) => draft.authorName)).toEqual([OPERATOR.username]);

        await user.click(within(await flowRow(FLOW_NAME)).getByRole('button', { name: 'Edit' }));
        expect(await screen.findByText('Unfinished business')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Load Your draft' }));
        await waitFor(() => expect(cardsOnCanvas()).toBe(3));
    });

    it('discards my draft and nobody else’s', async () => {
        const seeded = await guildWithFlow();
        const draftOf = (graph: FlowGraph) => ({ name: FLOW_NAME, graph, baseUpdatedAt: seeded.loadedAt });
        await seeded.api.send('PUT', `${seeded.flowPath}/drafts/mine`, draftOf(READY));
        await seeded.otherApi.send('PUT', `${seeded.flowPath}/drafts/mine`, draftOf(READY));
        const mine = (await draftsOf(seeded)).find((draft) => draft.authorName === OPERATOR.username);

        const dashboard = installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        // Mine, picked up where I left it, and taken further.
        await user.click(await screen.findByRole('button', { name: 'Load Your draft' }));
        await user.click(screen.getByTitle(ADD_SEND_DM));
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));
        const prompt = await screen.findByRole('dialog', { name: PROMPT });
        await user.click(within(prompt).getByRole('button', { name: 'Discard changes' }));

        await flowRow(FLOW_NAME);
        const deleted = dashboard.requests.findIndex(
            (request) => request.method === 'DELETE' && request.path === `${seeded.flowPath}/drafts/${mine?.draftId}`
        );
        expect(deleted).toBeGreaterThan(-1);
        // Leaving did not write the discarded canvas straight back.
        expect(dashboard.requests.slice(deleted)).not.toContainEqual({
            method: 'PUT',
            path: `${seeded.flowPath}/drafts/mine`,
        });
        expect((await draftsOf(seeded)).map((draft) => draft.authorName)).toEqual([OTHER.username]);
        expect((await seeded.api.send<StoredFlow>('GET', seeded.flowPath)).graph).toEqual(READY);

        // Back in: only moxie's is left to pick.
        await user.click(within(await flowRow(FLOW_NAME)).getByRole('button', { name: 'Edit' }));
        expect(await screen.findByText("@moxie's draft")).toBeTruthy();
        expect(screen.queryByText('Your draft')).toBeNull();
    });

    it('discards only what came after a draft-only save, and keeps the save', async () => {
        const seeded = await guildWithFlow({ enabled: true });
        installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        // Saved, but live and incomplete: it lands on my draft.
        expect(await screen.findByText('All changes saved')).toBeTruthy();
        await user.click(screen.getByTitle(ADD_SEND_DM));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('Draft saved — live flow unchanged')).toBeTruthy();

        // Then one more, discarded on the way out.
        await user.click(screen.getByTitle(ADD_SEND_DM));
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));
        const prompt = await screen.findByRole('dialog', { name: PROMPT });
        await user.click(within(prompt).getByRole('button', { name: 'Discard changes' }));

        await flowRow(FLOW_NAME);
        const drafts = await seeded.api.send<{ drafts: { authorName: string; graph: FlowGraph }[] }>(
            'GET',
            `${seeded.flowPath}/drafts`
        );
        expect(drafts.drafts.map((draft) => [draft.authorName, draft.graph.nodes.length])).toEqual([
            [OPERATOR.username, 3],
        ]);
        expect(await seeded.api.send<StoredFlow>('GET', seeded.flowPath)).toMatchObject({ enabled: true, graph: READY });
    });

    it('logs out without asking — it is not a navigation — and the edit is kept on the way out', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${seeded.flowId}`);

        expect(await screen.findByText('All changes saved')).toBeTruthy();
        await user.click(screen.getByTitle(ADD_SEND_DM));
        await user.click(screen.getByText(OPERATOR.username));
        await user.click(await screen.findByRole('menuitem', { name: 'Log out' }));

        expect(await screen.findByRole('link', { name: 'Log in with Discord' })).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: PROMPT })).toBeNull();
        // The builder's unmount flushed the edit, inside the autosave's pause.
        await waitFor(async () =>
            expect((await draftsOf(seeded)).map((draft) => draft.authorName)).toEqual([OPERATOR.username])
        );
    });

    it('holds the sidebar and the browser’s back button too', async () => {
        const seeded = await guildWithFlow();
        installDashboardApi(seeded.client, OPERATOR);
        const { user, router } = renderDashboard('/flows');

        await user.click(within(await flowRow(FLOW_NAME)).getByRole('button', { name: 'Edit' }));
        expect(await screen.findByText('All changes saved')).toBeTruthy();
        await user.click(screen.getByTitle(ADD_SEND_DM));

        await user.click(screen.getByRole('link', { name: 'Warnings' }));
        await user.click(within(await screen.findByRole('dialog', { name: PROMPT })).getByRole('button', { name: 'Stay' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: PROMPT })).toBeNull());
        expect(router.state.location.pathname).toBe(`/flows/${seeded.flowId}`);

        await router.navigate(-1);
        await user.click(within(await screen.findByRole('dialog', { name: PROMPT })).getByRole('button', { name: 'Stay' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: PROMPT })).toBeNull());
        expect(router.state.location.pathname).toBe(`/flows/${seeded.flowId}`);
        expect(cardsOnCanvas()).toBe(3);
    });
});
