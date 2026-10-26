import { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { ResourceDeclaration } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { installFakeApi } from '../../__tests__/support/fakeApi';
import { NO_UPLOADS } from '../../__tests__/support/noUploads';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { RESOURCE_SAVE_DEBOUNCE_MS, STALE_RESOURCES_MESSAGE } from '../resourceSaveQueue';
import { ResourcesPanel } from '../ResourcesPanel';
import { useResourceAutosave } from '../useResourceAutosave';

/**
 * The resource autosave's writes, in the order they are made.
 *
 * Each write is the whole list, so one stored after a newer one deletes what the newer one
 * added. A second write therefore waits for the first to answer rather than racing it on
 * another connection — the case a lost session sets up, by holding two writes and letting
 * them go together (`web/src/auth/sessionGate.ts`).
 */

const GUILD_ID = '900000000000000001';
const FLOW_ID = 'doorman';
const RESOURCES_PATH = `/api/guilds/${GUILD_ID}/flows/${FLOW_ID}/resources`;

const channel = (key: string): ResourceDeclaration => ({ key, kind: 'textChannel', defaultName: key });

/** The version the harness's list is loaded at, and the ones its saves move it to. */
const LOADED_AT = '2026-10-25T10:00:00.000Z';
const SAVED_ONCE = '2026-10-25T10:00:01.000Z';
const SAVED_TWICE = '2026-10-25T10:00:02.000Z';
/** The version another flow's list is loaded at. */
const OTHER_FLOW_LOADED_AT = '2026-10-25T11:00:00.000Z';

interface AutosaveHarness {
    readonly edit: (next: ResourceDeclaration[]) => void;
    /** The list the owning component holds now. */
    readonly current: () => ResourceDeclaration[];
    /** Every message the hook has shown, `null` for a cleared one. */
    readonly errors: (string | null)[];
    /**
     * Go to another flow, as the builder does: the route's flow id moves first, with the old
     * list still in hand and nothing loaded for the new one; then its list arrives.
     */
    readonly navigate: (flowId: string, loaded: { resources: ResourceDeclaration[]; updatedAt: string | null }) => void;
    /** Close the page: the component holding the hook unmounts. */
    readonly leave: () => void;
}

interface Shown {
    readonly flowId: string;
    readonly resources: ResourceDeclaration[];
    readonly updatedAt: string | null;
    readonly loaded: boolean;
}

/** The hook under a component that owns the list, as the builder does; `edit` replaces it. */
function renderAutosave(initial: ResourceDeclaration[]): AutosaveHarness {
    let setShown: (update: (current: Shown) => Shown) => void = () => undefined;
    let setMounted: (mounted: boolean) => void = () => undefined;
    let held = initial;
    const errors: (string | null)[] = [];

    function Harness({ shown }: { shown: Shown }) {
        held = shown.resources;
        useResourceAutosave({
            guildId: GUILD_ID,
            target: { kind: 'flow', flowId: shown.flowId },
            journeyKey: undefined,
            resources: shown.resources,
            updatedAt: shown.updatedAt,
            loaded: shown.loaded,
            onSaved: (stored) => setShown((current) => ({ ...current, ...stored })),
            onSavingChange: () => undefined,
            onError: (message) => errors.push(message),
        });
        return null;
    }

    function Page() {
        const [shown, setShownState] = useState<Shown>({ flowId: FLOW_ID, resources: initial, updatedAt: LOADED_AT, loaded: true });
        const [mounted, setMountedState] = useState(true);
        setShown = setShownState;
        setMounted = setMountedState;
        return mounted ? <Harness shown={shown} /> : null;
    }

    renderWithProviders(<Page />);
    return {
        edit: (next) => act(() => setShown((current) => ({ ...current, resources: next }))),
        current: () => held,
        errors,
        navigate: (flowId, loaded) => {
            act(() => setShown((current) => ({ ...current, flowId, loaded: false })));
            act(() => setShown(() => ({ flowId, ...loaded, loaded: true })));
        },
        leave: () => act(() => setMounted(false)),
    };
}

/** A save's answer: the list as sent, at `updatedAt`. */
function stored(body: unknown, updatedAt: string) {
    const { resources } = body as { resources: ResourceDeclaration[] };
    return { body: { resources, updatedAt } };
}

describe('useResourceAutosave', () => {
    it('sends a write only once the one before it has answered', async () => {
        const api = installFakeApi();
        const firstAnswer: { send?: () => void } = {};
        api.on('PUT', RESOURCES_PATH, ({ body }) => {
            if (!firstAnswer.send) {
                return new Promise((resolve) => (firstAnswer.send = () => resolve(stored(body, SAVED_ONCE))));
            }
            return stored(body, SAVED_TWICE);
        });
        const puts = () => api.requests.filter((request) => request.method === 'PUT');
        const { edit } = renderAutosave([channel('lobby')]);

        edit([channel('lobby'), channel('dungeon')]);
        await waitFor(() => expect(puts()).toHaveLength(1));
        edit([channel('lobby'), channel('dungeon'), channel('aftercare')]);
        // Well past the debounce: the newer list is waiting on the first, not on the timer.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(puts()).toHaveLength(1);

        firstAnswer.send?.();

        await waitFor(() => expect(puts()).toHaveLength(2));
        // The version the first save moved the journey to, though its answer was superseded.
        expect(puts()[1]?.body).toEqual({
            resources: [channel('lobby'), channel('dungeon'), channel('aftercare')],
            baseUpdatedAt: SAVED_ONCE,
        });
    });

    /**
     * Each save carries the version its list was edited from: the load's for the first, then
     * whatever the last save answered. A save carrying the load's version after the journey
     * had moved on would be refused as stale, though it was this very tab that moved it.
     */
    it('sends the loaded version, then the one each save answered with', async () => {
        const api = installFakeApi();
        let answered = 0;
        api.on('PUT', RESOURCES_PATH, ({ body }) => {
            answered += 1;
            return stored(body, answered === 1 ? SAVED_ONCE : SAVED_TWICE);
        });
        const puts = () => api.requests.filter((request) => request.method === 'PUT');
        const { edit } = renderAutosave([channel('lobby')]);

        edit([channel('lobby'), channel('dungeon')]);
        await waitFor(() => expect(puts()).toHaveLength(1));
        edit([channel('lobby'), channel('dungeon'), channel('aftercare')]);
        await waitFor(() => expect(puts()).toHaveLength(2));
        edit([channel('lobby')]);
        await waitFor(() => expect(puts()).toHaveLength(3));

        expect(puts().map((request) => (request.body as { baseUpdatedAt?: string }).baseUpdatedAt)).toEqual([
            LOADED_AT,
            SAVED_ONCE,
            SAVED_TWICE,
        ]);
    });

    /**
     * A stale save's 409 says somebody else saved since — not that the list on screen is
     * wrong — so the list stays as typed and the server's sentence is shown. No re-read goes
     * out: the fake API fails the test on any request nothing answers, a GET included.
     *
     * Every later save would be refused the same way, so none is sent: further typing stays on
     * screen, the sentence stays up, and leaving says that nothing was kept.
     */
    it('keeps the list as typed on a stale 409, stops sending, and says so on the way out', async () => {
        const api = installFakeApi();
        api.on('PUT', RESOURCES_PATH, () => ({ status: 409, body: { error: STALE_RESOURCES_MESSAGE } }));
        const puts = () => api.requests.filter((request) => request.method === 'PUT');
        const autosave = renderAutosave([channel('lobby')]);

        autosave.edit([channel('lobby'), channel('dungeon')]);
        await waitFor(() => expect(autosave.errors).toContain(STALE_RESOURCES_MESSAGE));

        expect(puts()).toHaveLength(1);
        expect(api.requests.filter((request) => request.method === 'GET')).toEqual([]);
        expect(autosave.current()).toEqual([channel('lobby'), channel('dungeon')]);

        autosave.edit([channel('lobby'), channel('dungeon'), channel('aftercare')]);
        await new Promise((resolve) => setTimeout(resolve, RESOURCE_SAVE_DEBOUNCE_MS + 400));
        expect(puts()).toHaveLength(1);
        // Never cleared: the reload sentence is the last thing said.
        expect(autosave.errors.at(-1)).toBe(STALE_RESOURCES_MESSAGE);

        autosave.leave();

        expect(await screen.findByText('Some resources were not saved')).toBeTruthy();
        expect(puts()).toHaveLength(1);
    });

    /**
     * The shared-journey 409 is a refusal of the write itself — other flows hold the journey —
     * not of a stale tab, so it reverts as every other refusal does, to the list the server holds.
     */
    it('reverts to the stored list on a 409 that is not the stale version', async () => {
        const api = installFakeApi();
        const shared = 'Replacing the resources on the journey Welcome would pull the rug out from under Doorman too.';
        api.on('PUT', RESOURCES_PATH, () => ({ status: 409, body: { error: shared } }));
        api.on('GET', RESOURCES_PATH, () => ({ body: { resources: [channel('lobby')], updatedAt: LOADED_AT } }));
        const autosave = renderAutosave([channel('lobby')]);

        autosave.edit([channel('lobby'), channel('dungeon')]);
        await waitFor(() => expect(autosave.errors).toContain(shared));

        await waitFor(() => expect(autosave.current()).toEqual([channel('lobby')]));
    });

    /**
     * Leaving a flow mid-save queues its flush behind the save while the next flow loads. The
     * flush must carry the version that save moved *its own* journey to — not the next flow's,
     * which it would get from one version shared by every flow, and be refused as stale.
     */
    it('sends a flush with its own flow’s version when the page has moved to another flow', async () => {
        const api = installFakeApi();
        const firstAnswer: { send?: () => void } = {};
        api.on('PUT', RESOURCES_PATH, ({ body }) => {
            if (!firstAnswer.send) {
                return new Promise((resolve) => (firstAnswer.send = () => resolve(stored(body, SAVED_ONCE))));
            }
            return stored(body, SAVED_TWICE);
        });
        const puts = () => api.requests.filter((request) => request.method === 'PUT');
        const autosave = renderAutosave([channel('lobby')]);

        autosave.edit([channel('lobby'), channel('dungeon')]);
        await waitFor(() => expect(puts()).toHaveLength(1));
        // Typed, then gone before the debounce: the flush carries it, behind the first save.
        autosave.edit([channel('lobby'), channel('dungeon'), channel('aftercare')]);
        autosave.navigate('dungeon-master', { resources: [channel('playroom')], updatedAt: OTHER_FLOW_LOADED_AT });

        firstAnswer.send?.();

        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(puts()[1]).toEqual({
            method: 'PUT',
            path: RESOURCES_PATH,
            body: { resources: [channel('lobby'), channel('dungeon'), channel('aftercare')], baseUpdatedAt: SAVED_ONCE },
        });
    });

    /**
     * The builder saves through the flow until the flow is linked, then through the journey
     * (`builderResourcesTarget`). That is another door into the same list: the save after the
     * switch carries the version the one before it answered with, from the hook's own books —
     * not the version the page last handed in, which may not have caught up.
     */
    it('carries the last save’s version through the door when the target moves to the journey', async () => {
        const api = installFakeApi();
        const journeyPath = `/api/guilds/${GUILD_ID}/journeys/${FLOW_ID}`;
        api.on('PUT', RESOURCES_PATH, ({ body }) => stored(body, SAVED_ONCE));
        api.on('PUT', journeyPath, ({ body }) => stored(body, SAVED_TWICE));
        const puts = () => api.requests.filter((request) => request.method === 'PUT');
        let moveToJourney: () => void = () => undefined;
        let edit: (next: ResourceDeclaration[]) => void = () => undefined;

        function Builder() {
            const [linked, setLinked] = useState(false);
            const [resources, setResources] = useState([channel('lobby')]);
            moveToJourney = () => setLinked(true);
            edit = setResources;
            useResourceAutosave({
                guildId: GUILD_ID,
                target: linked ? { kind: 'journey', journeyKey: FLOW_ID } : { kind: 'flow', flowId: FLOW_ID },
                subject: { kind: 'flow', flowId: FLOW_ID },
                journeyKey: FLOW_ID,
                resources,
                // Never moved on by a save here, so only the hook's own books can know SAVED_ONCE.
                updatedAt: LOADED_AT,
                loaded: true,
                onSaved: () => undefined,
                onSavingChange: () => undefined,
                onError: () => undefined,
            });
            return null;
        }

        renderWithProviders(<Builder />);
        act(() => edit([channel('lobby'), channel('dungeon')]));
        await waitFor(() => expect(puts()).toHaveLength(1));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        act(() => moveToJourney());
        act(() => edit([channel('lobby'), channel('dungeon'), channel('aftercare')]));

        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(puts()[1]).toEqual({
            method: 'PUT',
            path: journeyPath,
            body: { resources: [channel('lobby'), channel('dungeon'), channel('aftercare')], baseUpdatedAt: SAVED_ONCE },
        });
    });

    /**
     * A message the save would refuse is held rather than sent: the refusal's re-read would
     * put the stored message back over the window the author is typing in. The red chip is
     * what tells them nothing is being stored, and the save goes as soon as it is fixed.
     */
    it('holds a message the save would refuse, says so on the row, and sends it once fixed', async () => {
        const api = installFakeApi();
        api.on('PUT', RESOURCES_PATH, ({ body }) => stored(body, SAVED_ONCE));
        const puts = () => api.requests.filter((request) => request.method === 'PUT');
        const panel: ResourceDeclaration = {
            key: 'rules-panel',
            kind: 'message',
            defaultName: 'Rules panel',
            parentKey: 'rules',
            message: { embeds: [{ title: 'House rules' }] },
        };

        function PanelWithAutosave() {
            const [resources, setResources] = useState<ResourceDeclaration[]>([channel('rules'), panel]);
            useResourceAutosave({
                guildId: GUILD_ID,
                target: { kind: 'flow', flowId: FLOW_ID },
                journeyKey: undefined,
                resources,
                updatedAt: LOADED_AT,
                loaded: true,
                onSaved: () => undefined,
                onSavingChange: () => undefined,
                onError: () => undefined,
            });
            return <ResourcesPanel resources={resources} onChange={setResources} roles={[]} channels={[]} uploads={NO_UPLOADS} />;
        }

        const { user } = renderWithProviders(<PanelWithAutosave />);
        await user.click(screen.getByRole('button', { name: 'Expand Rules panel' }));
        await user.click(screen.getByRole('button', { name: 'Edit message' }));
        const window = screen.getByRole('dialog');

        // A fresh embed is empty, and an empty embed is refused.
        await user.click(within(window).getByRole('button', { name: 'Add embed' }));
        expect(screen.getByRole('button', { name: /Won’t save/ })).toBeTruthy();
        await new Promise((resolve) => setTimeout(resolve, RESOURCE_SAVE_DEBOUNCE_MS + 400));
        expect(puts()).toHaveLength(0);

        await user.click(within(window).getByRole('button', { name: 'Embed 2 title' }));
        await user.type(within(window).getByRole('textbox', { name: 'Embed 2 title' }), 'Safewords');

        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(puts()[0]?.body).toEqual({
            resources: [channel('rules'), { ...panel, message: { embeds: [{ title: 'House rules' }, { title: 'Safewords' }] } }],
            baseUpdatedAt: LOADED_AT,
        });
        expect(screen.queryByRole('button', { name: /Won’t save/ })).toBeNull();
    });
});
