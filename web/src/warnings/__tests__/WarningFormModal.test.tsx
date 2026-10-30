import { screen, waitFor, within } from '@testing-library/react';
import type { GuildMemberMatch, Warning, WarningResult } from '@brattybot/web-sdk';
import { describe, expect, it, vi } from 'vitest';
import { heldReply, installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { defaultDropsOff, pacificToday } from '../warningDates';
import { WarningFormModal, type WarningFormMode } from '../WarningFormModal';

/**
 * The issue and edit dialog against the fake API: the generated zod's sentences under the
 * fields, the member picked by name and sent by id, the server's date refusal under its
 * field, a refused search that keeps the form, and an edit that cannot be saved unchanged.
 */

const GUILD_ID = '900000000000000001';
const WARNINGS_PATH = `/api/guilds/${GUILD_ID}/warnings`;
const SEARCH_PATH = `/api/guilds/${GUILD_ID}/members/search`;
const KITTEN: GuildMemberMatch = { id: '400000000000000004', displayName: 'Kitten', username: 'kitten_irl', avatarUrl: null };
/** Somebody sharing Kitten's nickname — the picker must keep them apart by id. */
const OTHER_KITTEN: GuildMemberMatch = { id: '400000000000000014', displayName: 'Kitten', username: 'other_kitten', avatarUrl: null };

const WARNING: Warning = {
    slug: 'rope-burn-42',
    rule: 'No means no',
    description: 'Kept going after the safeword.',
    member: { id: KITTEN.id, name: 'Kitten' },
    issuedBy: { id: '500000000000000005', name: 'velvet_admin' },
    issuedOn: '2026-10-01',
    dropsOffOn: '2027-04-01',
    status: 'active',
    edited: { by: { id: '500000000000000005', name: 'velvet_admin' }, at: '2026-10-20T10:00:00.000Z' },
    released: null,
};

function renderDialog(mode: WarningFormMode, onClose: () => void = () => undefined) {
    return renderWithProviders(<WarningFormModal guildId={GUILD_ID} mode={mode} onClose={onClose} />);
}

function saved(overrides: Partial<WarningResult> = {}): { status: number; body: WarningResult } {
    return { status: 201, body: { ...WARNING, edited: null, notice: 'sent', ...overrides } };
}

async function pickKitten(user: ReturnType<typeof renderDialog>['user'], api: FakeApi): Promise<void> {
    api.on('GET', `${SEARCH_PATH}?q=kit`, () => ({ body: [KITTEN, OTHER_KITTEN] }));
    await user.type(screen.getByRole('textbox', { name: 'Member' }), 'kit');
    await user.click(await screen.findByRole('option', { name: /kitten_irl/ }));
}

describe('issuing a warning', () => {
    it("checks each field in the server's words once touched, and keeps Save off until all pass", async () => {
        installFakeApi();
        const { user } = renderDialog({ kind: 'issue' });
        const dialog = screen.getByRole('dialog', { name: 'Issue a warning' });
        const save = within(dialog).getByRole('button', { name: 'Issue warning' });

        // Nothing said on a form nobody has touched; Save is off all the same.
        expect(within(dialog).queryByText('Rule cannot be empty. Name the line they crossed.')).toBeNull();
        expect(save).toHaveProperty('disabled', true);

        const rule = within(dialog).getByRole('textbox', { name: 'Rule' });
        await user.type(rule, ' ');
        expect(within(dialog).getByText('Rule cannot be empty. Name the line they crossed.')).toBeTruthy();

        const dropsOff = within(dialog).getByRole('textbox', { name: 'Drops off' });
        await user.clear(dropsOff);
        await user.type(dropsOff, 'next spring');
        expect(within(dialog).getByText('Drop-off date has to be YYYY-MM-DD.')).toBeTruthy();
        expect(save).toHaveProperty('disabled', true);
    });

    it('opens on today, six months out — the defaults the server would use', () => {
        installFakeApi();
        renderDialog({ kind: 'issue' });
        const today = pacificToday();

        expect(screen.getByRole('textbox', { name: 'Issued' })).toHaveProperty('value', today);
        expect(screen.getByRole('textbox', { name: 'Drops off' })).toHaveProperty('value', defaultDropsOff(today));
    });

    it("says which of two same-named members was picked, by handle", async () => {
        const api = installFakeApi();
        const { user } = renderDialog({ kind: 'issue' });

        await pickKitten(user, api);

        expect(screen.getByText("That's @kitten_irl.")).toBeTruthy();
        expect(screen.queryByText("That's @other_kitten.")).toBeNull();
    });

    it('keeps the form when the server refuses an issue outright', async () => {
        const api = installFakeApi();
        api.on('POST', WARNINGS_PATH, () => ({ status: 404, body: { error: 'The bot is not in this server.' } }));
        const onClose = vi.fn();
        const { user } = renderDialog({ kind: 'issue' }, onClose);

        await pickKitten(user, api);
        await user.type(screen.getByRole('textbox', { name: 'Rule' }), 'No means no');
        await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Kept going.');
        await user.click(screen.getByRole('button', { name: 'Issue warning' }));

        expect(await screen.findByText('The bot is not in this server.')).toBeTruthy();
        expect(screen.queryByText('It moved under you')).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('textbox', { name: 'Rule' })).toHaveProperty('value', 'No means no');
    });

    it('cannot be closed while a save runs, and spins until it has landed', async () => {
        const api = installFakeApi();
        const post = heldReply();
        api.on('POST', WARNINGS_PATH, () => post.reply);
        const onClose = vi.fn();
        const { user } = renderDialog({ kind: 'issue' }, onClose);
        await pickKitten(user, api);
        await user.type(screen.getByRole('textbox', { name: 'Rule' }), 'No means no');
        await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Kept going.');

        await user.click(screen.getByRole('button', { name: 'Issue warning' }));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Issue warning' }).hasAttribute('data-loading')).toBe(true)
        );
        await user.keyboard('{Escape}');
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);

        post.send(saved());
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('searches for the member only once two letters are typed, and sends the one picked by id', async () => {
        const api = installFakeApi();
        api.on('POST', WARNINGS_PATH, () => saved({ notice: 'unconfigured' }));
        const onClose = vi.fn();
        const { user } = renderDialog({ kind: 'issue' }, onClose);

        await user.type(screen.getByRole('textbox', { name: 'Member' }), 'k');
        expect(await screen.findByText('Type at least two letters of their name.')).toBeTruthy();
        await user.clear(screen.getByRole('textbox', { name: 'Member' }));
        await pickKitten(user, api);
        await user.type(screen.getByRole('textbox', { name: 'Rule' }), 'No means no');
        await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Kept going after the safeword.');
        await user.click(screen.getByRole('button', { name: 'Issue warning' }));

        expect(await screen.findByText(/rope-burn-42 is on the record/)).toBeTruthy();
        // Saved, and said plainly that the mod log never heard.
        expect(screen.getByText('Saved, but nobody was told')).toBeTruthy();
        await waitFor(() => expect(onClose).toHaveBeenCalled());

        const searches = api.requests.filter((request) => request.path.startsWith(SEARCH_PATH));
        expect(searches.map((request) => request.path)).toEqual([`${SEARCH_PATH}?q=kit`]);
        const post = api.requests.find((request) => request.method === 'POST');
        expect(post?.body).toMatchObject({ userId: KITTEN.id, rule: 'No means no', issuedOn: pacificToday() });
    });

    it("keeps the form when the member search is refused, and shows the server's sentence", async () => {
        const api = installFakeApi();
        api.on('GET', `${SEARCH_PATH}?q=kit`, () => ({
            status: 429,
            body: { error: 'Easy, tiger. Too many requests — give it a minute.' },
        }));
        const { user } = renderDialog({ kind: 'issue' });
        await user.type(screen.getByRole('textbox', { name: 'Rule' }), 'No means no');

        await user.type(screen.getByRole('textbox', { name: 'Member' }), 'kit');

        expect(await screen.findByText('Easy, tiger. Too many requests — give it a minute.')).toBeTruthy();
        expect(screen.getByRole('textbox', { name: 'Rule' })).toHaveProperty('value', 'No means no');
    });

    it("puts the server's date refusal under the date it is about", async () => {
        const api = installFakeApi();
        const sentence = "Issued date can't be in the future. Backdate all you want — just not tomorrow.";
        api.on('POST', WARNINGS_PATH, () => ({ status: 400, body: { error: sentence } }));
        const onClose = vi.fn();
        const { user } = renderDialog({ kind: 'issue' }, onClose);

        await pickKitten(user, api);
        await user.type(screen.getByRole('textbox', { name: 'Rule' }), 'No means no');
        await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Kept going.');
        await user.click(screen.getByRole('button', { name: 'Issue warning' }));

        const issued = screen.getByRole('textbox', { name: 'Issued' });
        await waitFor(() => expect(issued.getAttribute('aria-invalid')).toBe('true'));
        expect(screen.getByText(sentence)).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe('editing a warning', () => {
    it('keeps Save off while nothing differs from what was loaded', async () => {
        installFakeApi();
        const { user } = renderDialog({ kind: 'edit', warning: WARNING });
        const save = screen.getByRole('button', { name: 'Save changes' });
        const rule = screen.getByRole('textbox', { name: 'Rule' });

        expect(rule).toHaveProperty('value', WARNING.rule);
        expect(save).toHaveProperty('disabled', true);
        // No member to pick and no issued date to move on an edit.
        expect(screen.queryByRole('textbox', { name: 'Member' })).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Issued' })).toBeNull();

        await user.type(rule, '!');
        expect(save).toHaveProperty('disabled', false);
        await user.type(rule, '{Backspace}');
        expect(save).toHaveProperty('disabled', true);
        await user.type(rule, '   ');
        expect(save).toHaveProperty('disabled', true);
    });

    it('sends the edit it loaded as its base', async () => {
        const api = installFakeApi();
        api.on('PUT', `${WARNINGS_PATH}/${WARNING.slug}`, () => ({ body: { ...saved().body, rule: 'No means NO' } }));
        const { user } = renderDialog({ kind: 'edit', warning: WARNING });

        const rule = screen.getByRole('textbox', { name: 'Rule' });
        await user.clear(rule);
        await user.type(rule, 'No means NO');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(/rope-burn-42 updated/)).toBeTruthy();
        expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({
            rule: 'No means NO',
            description: WARNING.description,
            dropsOffOn: WARNING.dropsOffOn,
            baseEditedAt: WARNING.edited?.at,
        });
    });

    it('says to reload, re-reads, and closes when somebody else edited it first', async () => {
        const api = installFakeApi();
        const sentence = 'Somebody else edited this warning while you had it open. Reload it and make your change again.';
        api.on('PUT', `${WARNINGS_PATH}/${WARNING.slug}`, () => ({ status: 409, body: { error: sentence } }));
        const onClose = vi.fn();
        const { user } = renderDialog({ kind: 'edit', warning: WARNING }, onClose);

        await user.type(screen.getByRole('textbox', { name: 'Description' }), ' Twice.');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(sentence)).toBeTruthy();
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});
