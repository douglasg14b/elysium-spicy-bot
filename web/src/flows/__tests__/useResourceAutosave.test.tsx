import { useState } from 'react';
import { act, waitFor } from '@testing-library/react';
import type { ResourceDeclaration } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { installFakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
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

/** The hook under a component that owns the list, as the builder does; `edit` replaces it. */
function renderAutosave(initial: ResourceDeclaration[]): { readonly edit: (next: ResourceDeclaration[]) => void } {
    let setList: (next: ResourceDeclaration[]) => void = () => undefined;

    function Harness() {
        const [resources, setResources] = useState(initial);
        setList = setResources;
        useResourceAutosave({
            guildId: GUILD_ID,
            target: { kind: 'flow', flowId: FLOW_ID },
            journeyKey: undefined,
            resources,
            loaded: true,
            onSaved: () => undefined,
            onSavingChange: () => undefined,
            onError: () => undefined,
        });
        return null;
    }

    renderWithProviders(<Harness />);
    return { edit: (next) => act(() => setList(next)) };
}

describe('useResourceAutosave', () => {
    it('sends a write only once the one before it has answered', async () => {
        const api = installFakeApi();
        const firstAnswer: { send?: () => void } = {};
        api.on('PUT', RESOURCES_PATH, ({ body }) => {
            const { resources } = body as { resources: ResourceDeclaration[] };
            if (!firstAnswer.send) {
                return new Promise((resolve) => (firstAnswer.send = () => resolve({ body: { resources } })));
            }
            return { body: { resources } };
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
        expect(puts()[1]?.body).toEqual({ resources: [channel('lobby'), channel('dungeon'), channel('aftercare')] });
    });
});
