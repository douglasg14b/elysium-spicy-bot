import { screen, waitFor, within } from '@testing-library/react';
import type { MemberName, Warning, WarningList } from '@brattybot/web-sdk';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { WarningsListPage } from '../WarningsListPage';

/**
 * The warnings list against the fake API: which query each filter sends, the empty table
 * told apart from a filtered-away one, the capped list said out loud, and the drawer.
 */

const GUILD_ID = '900000000000000001';
const LIST_PATH = `/api/guilds/${GUILD_ID}/warnings`;
const KITTEN = { id: '400000000000000004', name: 'Kitten' };
const MOD = { id: '500000000000000005', name: 'velvet_admin' };

function warning(overrides: Partial<Warning> = {}): Warning {
    return {
        slug: 'rope-burn-42',
        rule: 'No means no',
        description: 'Kept going after the safeword. Twice.',
        member: KITTEN,
        issuedBy: MOD,
        issuedOn: '2026-10-01',
        dropsOffOn: '2027-04-01',
        status: 'active',
        edited: null,
        released: null,
        ...overrides,
    };
}

function list(warnings: readonly Warning[], overrides: Partial<WarningList> = {}): { body: WarningList } {
    return {
        body: {
            warnings: [...warnings],
            counts: { active: 3, expired: 2, released: 1 },
            truncated: false,
            ...overrides,
        },
    };
}

/** The page's one names request for the people every fixture shows, Kitten and the mod. */
const NAMES_PATH = `/api/guilds/${GUILD_ID}/member-names?ids=${encodeURIComponent([KITTEN.id, MOD.id].join(','))}`;

/** The guild, and the bot remembering nobody unless a test says otherwise. */
function serveGuild(api: FakeApi, remembered: readonly MemberName[] = []): void {
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    api.on('GET', NAMES_PATH, () => ({ body: { members: [...remembered] } }));
}

function renderPage() {
    return renderWithProviders(
        <MemoryRouter>
            <GuildProvider>
                <WarningsListPage />
            </GuildProvider>
        </MemoryRouter>
    );
}

const listQueries = (api: FakeApi): string[] =>
    api.requests.filter((request) => request.path.startsWith(LIST_PATH)).map((request) => request.path);

describe('WarningsListPage', () => {
    it('opens on active warnings and shows each with its people and dates', async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()]));
        renderPage();

        const row = (await screen.findByText('No means no')).closest('tr');
        if (!row) throw new Error('The warning is not in a table row.');
        expect(within(row).getByText('Kitten')).toBeTruthy();
        expect(within(row).getByText('velvet_admin')).toBeTruthy();
        expect(within(row).getByText('rope-burn-42')).toBeTruthy();
        // Filtered to one status, every row would say the same thing: no status column.
        expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
        expect(listQueries(api)).toEqual([`${LIST_PATH}?status=active`]);
    });

    it('names each person as they go by now, over the name the row recorded, in the row, the chip and the drawer', async () => {
        const api = installFakeApi();
        serveGuild(api, [
            {
                userId: KITTEN.id,
                username: 'kittenuser',
                globalName: 'Kitten',
                nickname: 'Brat Princess',
                nicknames: ['Brat Princess', 'Kitten'],
                isBot: false,
                inServer: false,
                leftAt: '2026-10-29T12:00:00.000Z',
            },
        ]);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()]));
        api.on('GET', `${LIST_PATH}?status=active&userId=${KITTEN.id}`, () => list([warning()]));
        const { user } = renderPage();

        const name = await screen.findByText('Brat Princess');
        const row = name.closest('tr');
        if (!row) throw new Error('The warning is not in a table row.');
        expect(within(row).queryByText('Kitten')).toBeNull();
        // Nobody remembered the mod, so the row's own snapshot stands.
        expect(within(row).getByText('velvet_admin')).toBeTruthy();
        expect(api.requests.filter((request) => request.path.includes('/member-names'))).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: "Only Brat Princess's warnings" }));
        expect(await screen.findByText('Only Brat Princess')).toBeTruthy();
        await waitFor(() => expect(listQueries(api)).toContain(`${LIST_PATH}?status=active&userId=${KITTEN.id}`));

        // A list showing only people already asked about asks nothing more: each request spends Discord budget.
        api.on('GET', `${LIST_PATH}?status=released&userId=${KITTEN.id}`, () =>
            list([warning({ slug: 'self-own-1', rule: 'Self-snitching', status: 'released', issuedBy: KITTEN })])
        );
        await user.click(screen.getByRole('radio', { name: 'Released' }));
        expect(await screen.findByText('Self-snitching')).toBeTruthy();
        expect(api.requests.filter((request) => request.path.includes('/member-names'))).toHaveLength(1);
        await user.click(screen.getByRole('radio', { name: 'Active' }));

        await user.click(screen.getByRole('button', { name: 'Open rope-burn-42' }));
        const drawer = await screen.findByRole('dialog');
        expect(within(drawer).getByText('Brat Princess')).toBeTruthy();
    });

    it('filters by status from the tiles and the segmented control, showing status only under All', async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()]));
        api.on('GET', `${LIST_PATH}?status=expired`, () =>
            list([warning({ slug: 'mouthy-7', rule: 'Mind the mouth', status: 'expired' })])
        );
        api.on('GET', LIST_PATH, () =>
            list([warning(), warning({ slug: 'mouthy-7', rule: 'Mind the mouth', status: 'expired' })])
        );
        const { user } = renderPage();
        await screen.findByText('No means no');

        const expiredTile = screen.getByRole('button', { name: /^Expired/ });
        expect(expiredTile.getAttribute('aria-pressed')).toBe('false');
        await user.click(expiredTile);
        expect(await screen.findByText('Mind the mouth')).toBeTruthy();
        expect(expiredTile.getAttribute('aria-pressed')).toBe('true');

        await user.click(screen.getByRole('radio', { name: 'All' }));
        await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy());
        expect(listQueries(api)).toEqual([`${LIST_PATH}?status=active`, `${LIST_PATH}?status=expired`, LIST_PATH]);
    });

    it("filters to one member from their name, by id, and drops it with the chip's ×", async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()]));
        api.on('GET', `${LIST_PATH}?status=active&userId=${KITTEN.id}`, () => list([warning()]));
        const { user } = renderPage();

        await user.click(await screen.findByRole('button', { name: "Only Kitten's warnings" }));

        expect(await screen.findByText('Only Kitten')).toBeTruthy();
        // The name filters; it does not also open the drawer.
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() => expect(listQueries(api)).toContain(`${LIST_PATH}?status=active&userId=${KITTEN.id}`));

        await user.click(screen.getByRole('button', { name: 'Stop filtering to Kitten' }));
        expect(screen.queryByText('Only Kitten')).toBeNull();
    });

    it('debounces the search into one request for what was typed', async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()]));
        api.on('GET', `${LIST_PATH}?status=active&search=rope`, () => list([warning()]));
        const { user } = renderPage();
        await screen.findByText('No means no');

        await user.type(screen.getByRole('textbox', { name: 'Search warnings' }), 'rope');

        await waitFor(() => expect(listQueries(api)).toContain(`${LIST_PATH}?status=active&search=rope`));
        expect(listQueries(api)).toEqual([`${LIST_PATH}?status=active`, `${LIST_PATH}?status=active&search=rope`]);
    });

    it('tells a server with no warnings at all from a search that hides them', async () => {
        const api = installFakeApi();
        serveGuild(api);
        const none = { counts: { active: 0, expired: 0, released: 0 } };
        api.on('GET', `${LIST_PATH}?status=active`, () => list([], none));
        api.on('GET', LIST_PATH, () => list([], none));
        api.on('GET', `${LIST_PATH}?status=active&search=rope`, () => list([], none));
        const { user } = renderPage();

        expect(await screen.findByText('No warnings yet')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Issue a warning' })).toBeTruthy();
        // "All" is wider than the default, not a filter hiding anything.
        await user.click(screen.getByRole('radio', { name: 'All' }));
        await waitFor(() => expect(listQueries(api)).toContain(LIST_PATH));
        expect(screen.getByText('No warnings yet')).toBeTruthy();

        await user.click(screen.getByRole('radio', { name: 'Active' }));
        await user.type(screen.getByRole('textbox', { name: 'Search warnings' }), 'rope');

        expect(await screen.findByText('Nothing matches that')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(await screen.findByText('No warnings yet')).toBeTruthy();
    });

    it('opens a warning from the keyboard', async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()]));
        const { user } = renderPage();
        const open = await screen.findByRole('button', { name: 'Open rope-burn-42' });

        open.focus();
        await user.keyboard('{Enter}');

        const drawer = await screen.findByRole('dialog');
        expect(within(drawer).getByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('says when nobody is active but the record holds older warnings', async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([], { counts: { active: 0, expired: 4, released: 2 } }));
        renderPage();

        expect(await screen.findByText("Nobody's on thin ice")).toBeTruthy();
    });

    it('says out loud when the list was capped', async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()], { truncated: true }));
        renderPage();

        expect(await screen.findByText('Showing the newest 1 — narrow the search to see the rest.')).toBeTruthy();
    });

    it("shows a warning's whole record in the drawer, with no actions on a released one", async () => {
        const api = installFakeApi();
        serveGuild(api);
        api.on('GET', `${LIST_PATH}?status=active`, () => list([warning()]));
        api.on('GET', `${LIST_PATH}?status=released`, () =>
            list([
                warning({
                    status: 'released',
                    released: { by: { id: MOD.id, name: null }, at: '2026-10-20T10:00:00.000Z', reason: 'Grovelled beautifully.' },
                }),
            ])
        );
        const { user } = renderPage();

        await user.click(await screen.findByText('No means no'));
        const drawer = await screen.findByRole('dialog');
        expect(within(drawer).getByText('Kept going after the safeword. Twice.')).toBeTruthy();
        expect(within(drawer).getByRole('button', { name: 'Edit' })).toBeTruthy();
        expect(within(drawer).getByRole('button', { name: 'Release' })).toBeTruthy();
        await user.click(within(drawer).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(screen.getByRole('radio', { name: 'Released' }));
        await user.click(await screen.findByText('No means no'));
        const released = await screen.findByRole('dialog');
        expect(within(released).getByText('Grovelled beautifully.')).toBeTruthy();
        // A release recorded before names were: the id stands in.
        expect(within(released).getByText(new RegExp(MOD.id))).toBeTruthy();
        expect(within(released).queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(within(released).queryByRole('button', { name: 'Release' })).toBeNull();
    });
});
