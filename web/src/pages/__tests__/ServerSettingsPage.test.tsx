import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Guild, GuildSettings } from '../../api/types';
import { installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { ServerSettingsPage } from '../ServerSettingsPage';

/**
 * The time zone card: the ask while no zone is picked, and the ask going away once one
 * is saved.
 */

const GUILD: Guild = { id: 'guild-1', name: 'The Dungeon', iconURL: null, memberCount: 42 };
const SETTINGS_PATH = `/api/guilds/${GUILD.id}/settings`;

function settings(timeZone: string | null): GuildSettings {
    return { staffRoleIds: [], staffRoles: [], timeZone, defaultTimeZone: 'America/Los_Angeles' };
}

function installApi(timeZone: string | null): FakeApi {
    const api = installFakeApi();
    api.on('GET', '/api/guilds', () => ({ body: { guilds: [GUILD] } }));
    api.on('GET', SETTINGS_PATH, () => ({ body: settings(timeZone) }));
    api.on('GET', `/api/guilds/${GUILD.id}/roles`, () => ({ body: { roles: [STAFF_ROLE] } }));
    return api;
}

const STAFF_ROLE = { id: '111111111111111111', name: 'Doms', color: 0, position: 1 };

function renderPage() {
    return renderWithProviders(
        <GuildProvider>
            <ServerSettingsPage />
        </GuildProvider>
    );
}

const NOT_SET_NOTE = /Not set: using Pacific Time until you pick one/;
const NEW_YORK_OPTION = /^America\/New_York \(UTC[+\u2212]\d\d:\d\d\)$/;
const LONDON_OPTION = /^Europe\/London \(UTC[+\u2212]\d\d:\d\d\)$/;

describe('the server time zone', () => {
    it('asks for a zone until one is picked, and stops asking once it is saved', async () => {
        const api = installApi(null);
        api.on('PUT', `${SETTINGS_PATH}/time-zone`, (request) => ({
            body: settings((request.body as { timeZone: string }).timeZone),
        }));
        const { user } = renderPage();

        expect(await screen.findByText(NOT_SET_NOTE)).toBeTruthy();

        // Typed the way people type it, not the way the label spells it.
        await user.click(screen.getByRole('textbox', { name: 'Time zone' }));
        await user.type(screen.getByRole('textbox', { name: 'Time zone' }), 'new york');
        await user.click(screen.getByRole('option', { name: NEW_YORK_OPTION }));

        // Picked is not chosen: the ask stays until the save lands.
        expect(screen.getByText(NOT_SET_NOTE)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Save time zone' }));

        await waitFor(() => expect(screen.queryByText(NOT_SET_NOTE)).toBeNull());
        expect(api.requests.find((request) => request.method === 'PUT')).toEqual({
            method: 'PUT',
            path: `${SETTINGS_PATH}/time-zone`,
            body: { timeZone: 'America/New_York' },
        });
    });

    it('keeps a zone picked while an earlier save was still in flight', async () => {
        /*
         * The picker stays usable during a save. Pick New York, save, pick London before
         * the answer arrives: the answer must not put New York back over London, or the
         * card reads as saved while the operator's last pick is silently gone.
         */
        const api = installApi(null);
        let answer: () => void = () => undefined;
        api.on('PUT', `${SETTINGS_PATH}/time-zone`, (request) => {
            const body = settings((request.body as { timeZone: string }).timeZone);
            return new Promise((resolve) => {
                answer = () => resolve({ body });
            });
        });
        const { user } = renderPage();
        const picker = await screen.findByRole('textbox', { name: 'Time zone' });

        await user.click(picker);
        await user.type(picker, 'new york');
        await user.click(screen.getByRole('option', { name: NEW_YORK_OPTION }));
        await user.click(screen.getByRole('button', { name: 'Save time zone' }));

        await user.click(picker);
        await user.clear(picker);
        await user.type(picker, 'london');
        await user.click(screen.getByRole('option', { name: LONDON_OPTION }));
        answer();

        await waitFor(() => expect(screen.queryByText(NOT_SET_NOTE)).toBeNull());
        expect((picker as HTMLInputElement).value).toMatch(LONDON_OPTION);
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Save time zone' }).hasAttribute('disabled')).toBe(false)
        );
    });

    it('reads a save answered in another spelling as saved, with one entry for the zone', async () => {
        /*
         * Browsers disagree on spelling: this runtime lists `Asia/Calcutta`, Firefox
         * `Asia/Kolkata`. A server answering in the other spelling must not add a second
         * entry for the same zone, nor leave Save lit for a write that changes nothing.
         */
        const listed = Intl.supportedValuesOf('timeZone');
        const [sent, answered] = listed.includes('Asia/Calcutta')
            ? ['Asia/Calcutta', 'Asia/Kolkata']
            : ['Asia/Kolkata', 'Asia/Calcutta'];
        const api = installApi(null);
        api.on('PUT', `${SETTINGS_PATH}/time-zone`, () => ({ body: settings(answered) }));
        const { user } = renderPage();
        const picker = await screen.findByRole('textbox', { name: 'Time zone' });

        await user.click(picker);
        await user.type(picker, sent.split('/')[1]);
        await user.click(screen.getByRole('option', { name: new RegExp(`^${sent} \\(`) }));
        await user.click(screen.getByRole('button', { name: 'Save time zone' }));

        await waitFor(() => expect(screen.queryByText(NOT_SET_NOTE)).toBeNull());
        expect(screen.getByRole('button', { name: 'Save time zone' }).hasAttribute('disabled')).toBe(true);
        // Opened on the selected label, the picker lists every option unfiltered.
        await user.click(picker);
        expect(screen.getAllByRole('option', { name: /^Asia\/(Kolkata|Calcutta) \(/ })).toHaveLength(1);
    });

    it("keeps a saved zone when a staff save's late answer still carries the old one", async () => {
        // The staff route answers with the whole shape. Taken whole, its stale
        // `timeZone: null` would bring the ask back over a zone just saved.
        const api = installApi(null);
        api.on('PUT', `${SETTINGS_PATH}/time-zone`, (request) => ({
            body: settings((request.body as { timeZone: string }).timeZone),
        }));
        api.on('PUT', SETTINGS_PATH, () => ({
            body: { ...settings(null), staffRoleIds: [STAFF_ROLE.id], staffRoles: [STAFF_ROLE] },
        }));
        const { user } = renderPage();
        const picker = await screen.findByRole('textbox', { name: 'Time zone' });

        await user.click(picker);
        await user.type(picker, 'new york');
        await user.click(screen.getByRole('option', { name: NEW_YORK_OPTION }));
        await user.click(screen.getByRole('button', { name: 'Save time zone' }));
        await waitFor(() => expect(screen.queryByText(NOT_SET_NOTE)).toBeNull());

        await user.click(screen.getByRole('textbox', { name: 'Staff roles' }));
        await user.click(screen.getByRole('option', { name: STAFF_ROLE.name }));
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(api.requests.some((request) => request.path === SETTINGS_PATH && request.method === 'PUT')).toBe(true));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true));
        expect(screen.queryByText(NOT_SET_NOTE)).toBeNull();
    });

    it('does not ask on a server that already picked one', async () => {
        installApi('Europe/London');
        renderPage();

        await waitFor(() =>
            expect((screen.getByRole('textbox', { name: 'Time zone' }) as HTMLInputElement).value).toMatch(
                /^Europe\/London \(UTC/
            )
        );
        expect(screen.queryByText(NOT_SET_NOTE)).toBeNull();
        expect(screen.getByRole('button', { name: 'Save time zone' }).hasAttribute('disabled')).toBe(true);
    });
});
