import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GuildChannel, GuildRole, ResourceDeclaration, TicketTypeView } from '@brattybot/web-sdk';
import { NO_UPLOADS } from '../../__tests__/support/noUploads';
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
    readonly ticketTypes?: TicketTypeView[];
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
                ticketTypes={setup.ticketTypes}
                uploads={NO_UPLOADS}
            />
        );
    }

    const rendered = renderWithProviders(<ControlledPanel />);
    return { ...rendered, current: () => latest };
}

function channel(id: string, name: string): GuildChannel {
    return { id, name, type: 'text', parentId: null, parentName: null, owner: null };
}

function role(id: string, name: string): GuildRole {
    return { id, name, color: 0, position: 1, owner: null };
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

        expect(current()[0]?.adoptDiscordId).toBeUndefined();
        // Starts the name over: the `#` of the label it was typed into is decoration.
        expect(current()[0]?.defaultName).toBe('x');
        expect(name.value).toBe('x');

        // And the next keystroke is ordinary typing on a row that is no longer adopted.
        await user.type(name, 'y');
        expect(current()[0]?.defaultName).toBe('xy');
    });

    it('starts over from nothing when an adopted name is backspaced', async () => {
        const { user, current } = renderPanel({
            resources: [
                { key: 'general', kind: 'textChannel', defaultName: 'general', adoptDiscordId: 'c1' },
            ],
            channels: [{ id: 'c1', name: 'general', type: 'text', parentId: 'p1', parentName: 'Support', owner: null }],
        });

        const name = await openRow(user, 'general');
        expect(name.value).toBe('#general · in Support');
        await user.type(name, '{Backspace}');

        expect(current()[0]).toMatchObject({ defaultName: '' });
        expect(current()[0]?.adoptDiscordId).toBeUndefined();
        expect(name.value).toBe('');

        // The key waited through the empty name and follows the new one.
        await user.type(name, 'lobby');
        expect(current()[0]).toMatchObject({ defaultName: 'lobby', key: 'lobby' });
    });

    it('keeps a hand-typed key when the name is cleared and retyped', async () => {
        const { user, current } = renderPanel({
            resources: [{ key: 'games', kind: 'textChannel', defaultName: 'games' }],
        });

        const name = await openRow(user, 'games');
        const key = screen.getByRole('textbox', { name: 'Key' });
        await user.clear(key);
        await user.type(key, 'arcade');
        await user.clear(name);
        await user.type(name, 'lobby');

        expect(current()[0]).toMatchObject({ defaultName: 'lobby', key: 'arcade' });
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

    describe('a ticket type', () => {
        const PERMISSIONS = {
            subject: { view: true, send: true, readHistory: true, manageMessages: false },
            opener: { view: true, send: true, readHistory: true, manageMessages: false },
            staff: { view: true, send: true, readHistory: true, manageMessages: true },
        };
        const VERIFICATION: TicketTypeView = {
            type: 'verification',
            label: 'Verification',
            nameTemplate: 'V{{####}}-{{subject}}',
            permissions: PERMISSIONS,
            autoClaimOnOpen: false,
            categories: { open: null, claimed: null, closed: null },
        };

        it('is added with the tickets page’s starting settings, and its label is edited without moving its key', async () => {
            const { user, current } = renderPanel({ resources: [] });

            await user.click(screen.getByRole('button', { name: 'Ticket type' }));
            const added = current()[0];
            expect(added).toMatchObject({ kind: 'ticketType', key: 'new-ticket-type', defaultName: 'New ticket type' });
            expect(added?.ticketType?.nameTemplate).toBe('T{{####}}-{{subject}}');

            const label = screen.getByRole('textbox', { name: 'Label' });
            await user.clear(label);
            await user.type(label, 'Front Desk');

            // The key names the type, so a rename never carries it along.
            expect(current()[0]).toMatchObject({ defaultName: 'Front Desk', key: 'new-ticket-type' });
            // And nothing a channel has: no category, no channel rules.
            expect(screen.queryByRole('textbox', { name: 'Inside category' })).toBeNull();
            expect(screen.queryByText('Who can see it')).toBeNull();
        });

        it('writes the template and the permission grid into the declaration', async () => {
            const { user, current } = renderPanel({
                resources: [
                    {
                        key: 'front-desk',
                        kind: 'ticketType',
                        defaultName: 'Front desk',
                        ticketType: { nameTemplate: 'desk-{{####}}', permissions: PERMISSIONS, autoClaimOnOpen: false },
                    },
                ],
            });

            await user.click(screen.getByRole('button', { name: 'Expand Front desk' }));
            const template = screen.getByRole('textbox', { name: 'Channel name template' });
            await user.clear(template);
            await user.type(template, 'fd-{{{{####}}');
            await user.click(screen.getByRole('checkbox', { name: 'Opener can manage' }));

            expect(current()[0]?.ticketType).toEqual({
                nameTemplate: 'fd-{{####}}',
                permissions: { ...PERMISSIONS, opener: { ...PERMISSIONS.opener, manageMessages: true } },
                autoClaimOnOpen: false,
            });
        });

        it('says when the server already has the key, and stays quiet once this journey installed it', () => {
            const resources: ResourceDeclaration[] = [
                {
                    key: 'verification',
                    kind: 'ticketType',
                    defaultName: 'Verify',
                    ticketType: { nameTemplate: 'v-{{####}}', permissions: PERMISSIONS, autoClaimOnOpen: false },
                },
            ];

            const fresh = renderPanel({ resources, ticketTypes: [VERIFICATION] });
            expect(screen.getByText('Already here')).toBeTruthy();
            fresh.unmount();

            renderPanel({ resources, ticketTypes: [VERIFICATION], installedKeys: new Set(['verification']) });
            expect(screen.queryByText('Already here')).toBeNull();
        });
    });

    describe('a message', () => {
        const DECLARED: ResourceDeclaration[] = [
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
            { key: 'rules', kind: 'textChannel', defaultName: 'rules', parentKey: 'arrivals' },
            { key: 'lobby', kind: 'textChannel', defaultName: 'lobby' },
            { key: 'verified', kind: 'role', defaultName: 'Verified' },
        ];
        const PANEL: ResourceDeclaration = {
            key: 'rules-panel',
            kind: 'message',
            defaultName: 'Rules panel',
            parentKey: 'rules',
            message: { embeds: [{ title: 'House rules' }] },
            buttons: [{ key: 'let-me-in', label: 'Let me in', style: 'Success' }],
        };

        it('is added in the first declared channel, on one embed titled with its name', async () => {
            const { user, current } = renderPanel({ resources: DECLARED });

            await user.click(screen.getByRole('button', { name: 'Message' }));

            expect(current().at(-1)).toEqual({
                key: 'new-message',
                kind: 'message',
                defaultName: 'New message',
                parentKey: 'rules',
                message: { embeds: [{ title: 'New message' }] },
            });
            expect(screen.getByRole('textbox', { name: 'Name' })).toBe(document.activeElement);
            expect(screen.getByText('1 embed')).toBeTruthy();
        });

        it('offers only the declared text channels to post it in', async () => {
            const { user, current } = renderPanel({ resources: [...DECLARED, PANEL] });

            await user.click(screen.getByRole('button', { name: 'Expand Rules panel' }));
            await user.click(screen.getByRole('textbox', { name: 'Posted in' }));

            expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['#rules', '#lobby']);
            await user.click(screen.getByRole('option', { name: '#lobby' }));
            expect(current().at(-1)?.parentKey).toBe('lobby');
        });

        it('fixes the channel once installed, without disabling the field', async () => {
            const { user, current } = renderPanel({
                resources: [...DECLARED, PANEL],
                installedKeys: new Set(['rules-panel']),
            });

            await user.click(screen.getByRole('button', { name: 'Expand Rules panel' }));
            const picker = screen.getByRole('textbox', { name: 'Posted in' });

            expect(picker.hasAttribute('readonly')).toBe(true);
            expect(picker.hasAttribute('disabled')).toBe(false);
            expect(screen.getByText(/Discord can't move a message/)).toBeTruthy();
            // No clear button either, which would move it to no channel at all.
            expect(current().at(-1)?.parentKey).toBe('rules');
        });

        it('opens the message window with its buttons, and writes an edit back to the row', async () => {
            const { user, current } = renderPanel({ resources: [...DECLARED, PANEL] });

            await user.click(screen.getByRole('button', { name: 'Expand Rules panel' }));
            await user.click(screen.getByRole('button', { name: 'Edit message' }));
            const window = screen.getByRole('dialog');
            expect(within(window).getByRole('button', { name: 'Let me in' })).toBeTruthy();

            await user.click(within(window).getByRole('button', { name: 'Add button' }));
            await user.click(within(window).getByRole('button', { name: 'Embed 1 title' }));
            await user.type(within(window).getByRole('textbox', { name: 'Embed 1 title' }), '!');

            expect(current().at(-1)).toMatchObject({
                message: { embeds: [{ title: 'House rules!' }] },
                buttons: [
                    { key: 'let-me-in', label: 'Let me in', style: 'Success' },
                    { key: 'new-button', label: 'New button', style: 'Primary' },
                ],
            });
        });

        it('puts the message and the buttons back together on Cancel', async () => {
            const { user, current } = renderPanel({ resources: [...DECLARED, PANEL] });

            await user.click(screen.getByRole('button', { name: 'Expand Rules panel' }));
            await user.click(screen.getByRole('button', { name: 'Edit message' }));
            const window = screen.getByRole('dialog');
            await user.click(within(window).getByRole('button', { name: 'Add button' }));
            await user.click(within(window).getByRole('button', { name: 'Embed 1 title' }));
            await user.type(within(window).getByRole('textbox', { name: 'Embed 1 title' }), '!');
            await user.click(within(window).getByRole('button', { name: 'Cancel' }));

            // Both put back, in two writes on one tick — neither may undo the other.
            expect(current().at(-1)).toEqual(PANEL);
        });

        it('wears a red chip saying why, and an orange one with no channel', async () => {
            renderPanel({
                resources: [
                    ...DECLARED,
                    { ...PANEL, message: { embeds: [{ title: 'Hi {{subject.displayName}}' }] } },
                    { ...PANEL, key: 'stray', defaultName: 'Stray', parentKey: undefined },
                ],
            });

            expect(screen.getByRole('button', { name: /Won’t save/ })).toBeTruthy();
            expect(screen.getByRole('button', { name: /No channel/ })).toBeTruthy();
        });
    });
});
