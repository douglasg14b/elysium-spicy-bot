import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GuildChannel, GuildRole, ResourceDeclaration } from '../../api/types';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { ResourcesPanel } from '../ResourcesPanel';

/**
 * The resources panel, rendered, typed into and clicked — the decisions that live in the
 * component itself rather than in the `.ts` modules beside it.
 *
 * Every case here is something an operator hit or could hit live that no logic test
 * could see, because the fault was in how the component wired a correct rule to Mantine:
 * a crash inside `Collapse`, a pick arriving as two `onChange` calls, a chip that fired on
 * every installed row.
 */

interface PanelSetup {
    readonly resources: ResourceDeclaration[];
    readonly channels?: GuildChannel[];
    readonly roles?: GuildRole[];
    readonly installedKeys?: ReadonlySet<string>;
}

/**
 * The panel is controlled, so it is rendered under a parent that owns the list the way
 * the builder does. `current()` reads the list the panel last handed back — what the
 * autosave would send.
 */
function renderPanel(setup: PanelSetup) {
    let latest = setup.resources;

    function ControlledPanel() {
        const [resources, setResources] = useState(setup.resources);
        return (
            <ResourcesPanel
                resources={resources}
                onChange={(next) => {
                    latest = next;
                    setResources(next);
                }}
                channels={setup.channels ?? []}
                roles={setup.roles ?? []}
                installedKeys={setup.installedKeys}
            />
        );
    }

    const rendered = renderWithProviders(<ControlledPanel />);
    return { ...rendered, current: () => latest };
}

function channel(id: string, name: string): GuildChannel {
    return { id, name, type: 'text', parentId: null, parentName: null };
}

function role(id: string, name: string): GuildRole {
    return { id, name, color: 0, position: 1 };
}

/** Open a row by the name it shows, and return its Name combobox. */
async function openRow(
    user: ReturnType<typeof renderPanel>['user'],
    name: string
): Promise<HTMLInputElement> {
    await user.click(screen.getByRole('button', { name: `Expand ${name}` }));
    return screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
}

describe('ResourcesPanel', () => {
    it('offers two same-named roles side by side, and binds the one picked', async () => {
        // Mantine throws during render on a duplicate option value, which took the whole
        // panel down the first time a guild had two roles called Verified.
        const { user, current } = renderPanel({
            resources: [{ key: 'members', kind: 'role', defaultName: 'members' }],
            roles: [role('r1', 'Verified'), role('r2', 'Verified')],
        });

        const name = await openRow(user, 'members');
        await user.clear(name);
        await user.type(name, 'Verified');

        const options = screen.getAllByRole('option');
        expect(options.map((option) => option.textContent)).toEqual([
            '@Verified (r1)',
            '@Verified (r2)',
        ]);

        await user.click(screen.getByRole('option', { name: '@Verified (r2)' }));

        expect(current()[0]).toMatchObject({ adoptDiscordId: 'r2', defaultName: 'Verified' });
        // The field keeps saying which of the two it is once the dropdown shuts.
        expect(name.value).toBe('@Verified (r2)');
    });

    it('names a row after what it adopts when the name was cleared to search', async () => {
        const { user, current } = renderPanel({
            resources: [{ key: 'games', kind: 'textChannel', defaultName: 'games' }],
            channels: [channel('c1', 'rules'), channel('c2', 'lobby')],
        });

        const name = await openRow(user, 'games');
        await user.clear(name);
        expect(screen.getByRole('button', { name: /Name required/ })).toBeTruthy();

        await user.click(screen.getByRole('option', { name: '#rules' }));

        expect(current()[0]).toMatchObject({ adoptDiscordId: 'c1', defaultName: 'rules' });
        expect(name.value).toBe('#rules');
        expect(screen.queryByRole('button', { name: /Name required/ })).toBeNull();
    });

    it('drops the adoption when a different name is typed over it, in the same save', async () => {
        const { user, current } = renderPanel({
            resources: [
                { key: 'rules', kind: 'textChannel', defaultName: 'rules', adoptDiscordId: 'c1' },
            ],
            channels: [channel('c1', 'rules')],
        });

        const name = await openRow(user, 'rules');
        await user.type(name, 'x');

        // Only the adoption is asserted. What the *name* should become is open: the field
        // shows the adopted label, `#rules`, so the keystroke lands on the decoration too.
        expect(current()[0]?.adoptDiscordId).toBeUndefined();
    });

    describe('Name taken', () => {
        const resources: ResourceDeclaration[] = [
            { key: 'lobby', kind: 'textChannel', defaultName: 'lobby' },
        ];
        const channels = [channel('c2', 'lobby')];

        it('warns when a guild channel already holds the name a new row would create', () => {
            renderPanel({ resources, channels, installedKeys: new Set() });

            expect(screen.getByText('Name taken')).toBeTruthy();
        });

        it('stays quiet on a row install created, since the channel holding it is ours', () => {
            renderPanel({ resources, channels, installedKeys: new Set(['lobby']) });

            expect(screen.queryByText('Name taken')).toBeNull();
        });
    });

    describe('text channel names', () => {
        it('shows the name Discord will store as it is typed', async () => {
            const { user, current } = renderPanel({
                resources: [{ key: 'welcome', kind: 'textChannel', defaultName: 'welcome' }],
            });

            const name = await openRow(user, 'welcome');
            await user.clear(name);
            await user.type(name, 'Welcome Mat');

            expect(name.value).toBe('welcome-mat');
            expect(current()[0]?.defaultName).toBe('welcome-mat');
        });

        it('keeps the cursor where it was when a space is typed mid-name', async () => {
            // Normalising rewrites the value the browser just changed, and React writing a
            // different value into a focused input moves the cursor to the end.
            const { user } = renderPanel({
                resources: [{ key: 'welcomemat', kind: 'textChannel', defaultName: 'welcomemat' }],
            });

            const name = await openRow(user, 'welcomemat');
            await user.click(name);
            name.setSelectionRange(7, 7);
            await user.keyboard(' x');

            expect(name.value).toBe('welcome-xmat');
        });

        it('leaves a category name exactly as typed', async () => {
            const { user, current } = renderPanel({
                resources: [{ key: 'desk', kind: 'category', defaultName: 'desk' }],
            });

            const name = await openRow(user, 'desk');
            await user.clear(name);
            await user.type(name, 'Front Desk');

            expect(current()[0]?.defaultName).toBe('Front Desk');
        });
    });

    it('keeps rows it did not touch out of the accessibility tree', () => {
        renderPanel({
            resources: [
                { key: 'one', kind: 'textChannel', defaultName: 'one' },
                { key: 'two', kind: 'textChannel', defaultName: 'two' },
            ],
        });

        // Both bodies are mounted inside `Collapse`, and a query that found the closed
        // one's field would let a test type into a row the operator cannot see.
        expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
        expect(within(document.body).getAllByRole('button', { name: /^Expand/ })).toHaveLength(2);
    });
});
