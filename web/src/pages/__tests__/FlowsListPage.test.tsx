import { screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { FlowSummary } from '@brattybot/web-sdk';
import { heldReply, installFakeApi, type FakeApi, type FakeApiReply } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { FlowsListPage } from '../FlowsListPage';

/**
 * The flows list's switches, against the fake API: several in flight at once, and a list
 * refresh a switch interrupts.
 *
 * A switch cancels any list read in flight — that read would land after the switch and
 * put the old state back — and re-reads once the switches settle. These hold the two
 * things that used to go missing: each switch's own busy state, and the failure toast of
 * a refresh the switch interrupted.
 */

const GUILD_ID = '900000000000000001';
const FLOWS_PATH = `/api/guilds/${GUILD_ID}/flows`;

function summary(flowId: string, name: string): FlowSummary {
    return {
        flowId,
        name,
        enabled: false,
        issueCount: 0,
        nodeCount: 2,
        journey: null,
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
    };
}

const ROPE = summary('11111111-1111-1111-1111-111111111111', 'Rope check');
const WAX = summary('22222222-2222-2222-2222-222222222222', 'Wax play waiver');

/** The answer to a switch's PUT: the flow as stored, now with `enabled` as asked. */
function switched(flow: FlowSummary, enabled: boolean): FakeApiReply {
    return {
        body: {
            flowId: flow.flowId,
            name: flow.name,
            enabled,
            graph: { version: 1, nodes: [], edges: [] },
            issues: [],
            createdAt: flow.createdAt,
            updatedAt: '2026-10-04T10:00:00.000Z',
        },
    };
}

function serveGuild(api: FakeApi, flows: readonly FlowSummary[]): void {
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    api.on('GET', FLOWS_PATH, () => ({ body: { flows } }));
}

function renderPage() {
    return renderWithProviders(
        <MemoryRouter>
            <GuildProvider>
                <FlowsListPage />
            </GuildProvider>
        </MemoryRouter>
    );
}

/** A flow's on/off switch, found by the label the row gives it. */
function switchFor(flow: FlowSummary): HTMLInputElement {
    return screen.getByRole('switch', { name: `Enable ${flow.name}` }) as HTMLInputElement;
}

describe('FlowsListPage switches', () => {
    it('keeps every switch in flight busy until its own answer lands', async () => {
        const api = installFakeApi();
        serveGuild(api, [ROPE, WAX]);
        const ropePut = heldReply();
        const waxPut = heldReply();
        api.on('PUT', `${FLOWS_PATH}/${ROPE.flowId}`, () => ropePut.reply);
        api.on('PUT', `${FLOWS_PATH}/${WAX.flowId}`, () => waxPut.reply);
        const { user } = renderPage();
        await screen.findByText(ROPE.name, { selector: 'td *' });

        await user.click(switchFor(ROPE));
        await user.click(switchFor(WAX));

        // The second switch does not free the first.
        await waitFor(() => expect(switchFor(WAX).disabled).toBe(true));
        expect(switchFor(ROPE).disabled).toBe(true);

        waxPut.send(switched(WAX, true));
        await waitFor(() => expect(switchFor(WAX).disabled).toBe(false));
        expect(switchFor(ROPE).disabled).toBe(true);

        ropePut.send(switched(ROPE, true));
        await waitFor(() => expect(switchFor(ROPE).disabled).toBe(false));
        expect(switchFor(ROPE).checked).toBe(true);
        expect(switchFor(WAX).checked).toBe(true);
    });

    it('still says so when a refresh a switch interrupted fails', async () => {
        const api = installFakeApi();
        serveGuild(api, [ROPE, WAX]);
        api.on('GET', `${FLOWS_PATH}/${ROPE.flowId}/published`, () => ({
            body: { buttonMessages: [], deletableResources: [], refusedResources: [], mayHaveUnrecordedButtons: false },
        }));
        api.on('DELETE', `${FLOWS_PATH}/${ROPE.flowId}`, () => ({ status: 204 }));
        api.on('PUT', `${FLOWS_PATH}/${WAX.flowId}`, () => switched(WAX, true));
        const { user } = renderPage();
        const row = (await screen.findByText(ROPE.name, { selector: 'td *' })).closest('tr');
        if (!row) throw new Error('The flow has no row.');

        // The delete's loud refresh is held in flight…
        const refresh = heldReply();
        api.on('GET', FLOWS_PATH, () => refresh.reply);
        await user.click(within(row).getByRole('button', { name: `Delete ${ROPE.name}` }));
        const dialog = await screen.findByRole('dialog', { name: `What ${ROPE.name} has in your server` });
        await user.click(within(dialog).getByRole('button', { name: 'Delete flow' }));
        await waitFor(() =>
            expect(api.requests.filter((request) => request.method === 'GET' && request.path === FLOWS_PATH)).toHaveLength(2)
        );

        // …when a switch cancels it. The read the switch owes back fails.
        api.on('GET', FLOWS_PATH, () => ({ status: 500, body: { error: 'The flows table is having a moment.' } }));
        await user.click(switchFor(WAX));

        expect(await screen.findByText('The flows table is having a moment.')).toBeTruthy();
        expect(screen.getByText("Couldn't refresh")).toBeTruthy();
        refresh.send({ body: { flows: [WAX] } });
    });

    it('holds a refresh asked for during a switch until the switch has landed', async () => {
        // Read while the PUT flies, the list could come back with the row as it was before
        // the switch and land over it. So the read waits, and goes out once afterwards.
        const api = installFakeApi();
        serveGuild(api, [ROPE, WAX]);
        api.on('GET', `${FLOWS_PATH}/${ROPE.flowId}/published`, () => ({
            body: { buttonMessages: [], deletableResources: [], refusedResources: [], mayHaveUnrecordedButtons: false },
        }));
        api.on('DELETE', `${FLOWS_PATH}/${ROPE.flowId}`, () => ({ status: 204 }));
        const waxPut = heldReply();
        api.on('PUT', `${FLOWS_PATH}/${WAX.flowId}`, () => waxPut.reply);
        const { user } = renderPage();
        const row = (await screen.findByText(ROPE.name, { selector: 'td *' })).closest('tr');
        if (!row) throw new Error('The flow has no row.');
        const listReads = (): number =>
            api.requests.filter((request) => request.method === 'GET' && request.path === FLOWS_PATH).length;

        await user.click(switchFor(WAX));
        await user.click(within(row).getByRole('button', { name: `Delete ${ROPE.name}` }));
        const dialog = await screen.findByRole('dialog', { name: `What ${ROPE.name} has in your server` });
        await user.click(within(dialog).getByRole('button', { name: 'Delete flow' }));
        await screen.findByText(`"${ROPE.name}" has been shown the door.`);
        expect(listReads()).toBe(1);

        api.on('GET', FLOWS_PATH, () => ({ body: { flows: [{ ...WAX, enabled: true }] } }));
        waxPut.send(switched(WAX, true));

        await waitFor(() => expect(listReads()).toBe(2));
        await waitFor(() => expect(screen.queryByText(ROPE.name, { selector: 'td *' })).toBeNull());
        expect(switchFor(WAX).checked).toBe(true);
    });
});
