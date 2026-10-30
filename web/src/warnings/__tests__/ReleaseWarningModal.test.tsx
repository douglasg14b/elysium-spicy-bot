import { screen, waitFor } from '@testing-library/react';
import type { Warning } from '@brattybot/web-sdk';
import { describe, expect, it, vi } from 'vitest';
import { installFakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { ReleaseWarningModal } from '../ReleaseWarningModal';

/** The release confirm: whose and what it names, and the reason it will not go without. */

const GUILD_ID = '900000000000000001';
const RELEASE_PATH = `/api/guilds/${GUILD_ID}/warnings/rope-burn-42/release`;

const WARNING: Warning = {
    slug: 'rope-burn-42',
    rule: 'No means no',
    description: 'Kept going after the safeword.',
    member: { id: '400000000000000004', name: 'Kitten' },
    issuedBy: { id: '500000000000000005', name: 'velvet_admin' },
    issuedOn: '2026-10-01',
    dropsOffOn: '2027-04-01',
    status: 'expired',
    edited: null,
    released: null,
};

function renderConfirm(onClose: () => void = () => undefined) {
    return renderWithProviders(<ReleaseWarningModal guildId={GUILD_ID} warning={WARNING} onClose={onClose} />);
}

describe('ReleaseWarningModal', () => {
    it('names the member and the rule', () => {
        installFakeApi();
        renderConfirm();

        const dialog = screen.getByRole('dialog', { name: 'Release warning' });
        expect(dialog.textContent).toContain('Kitten');
        expect(dialog.textContent).toContain('No means no');
    });

    it("will not release without a reason, and says so in the server's words", async () => {
        const api = installFakeApi();
        const { user } = renderConfirm();
        const release = screen.getByRole('button', { name: 'Release warning' });

        expect(release).toHaveProperty('disabled', true);
        await user.type(screen.getByRole('textbox', { name: 'Reason' }), '   ');

        expect(screen.getByText("A release needs a reason. Say why they're off the hook.")).toBeTruthy();
        expect(release).toHaveProperty('disabled', true);
        await user.click(release);
        expect(api.requests.filter((request) => request.method === 'POST')).toEqual([]);
    });

    it('releases with the reason, trimmed, and says so naming the slug', async () => {
        const api = installFakeApi();
        api.on('POST', RELEASE_PATH, () => ({
            body: {
                ...WARNING,
                status: 'released',
                released: { by: { id: '500000000000000005', name: 'velvet_admin' }, at: '2026-10-29T10:00:00.000Z', reason: 'Grovelled.' },
                notice: 'sent',
            },
        }));
        const onClose = vi.fn();
        const { user } = renderConfirm(onClose);

        await user.type(screen.getByRole('textbox', { name: 'Reason' }), ' Grovelled. ');
        await user.click(screen.getByRole('button', { name: 'Release warning' }));

        expect(await screen.findByText(/rope-burn-42 released/)).toBeTruthy();
        expect(screen.queryByText(/Saved, but/)).toBeNull();
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(api.requests.find((request) => request.method === 'POST')?.body).toEqual({ reason: 'Grovelled.' });
    });

    it('closes and says why when somebody released it first', async () => {
        const api = installFakeApi();
        api.on('POST', RELEASE_PATH, () => ({
            status: 409,
            body: { error: '`rope-burn-42` is already cleared. You already did the soft thing.' },
        }));
        const onClose = vi.fn();
        const { user } = renderConfirm(onClose);

        await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Grovelled.');
        await user.click(screen.getByRole('button', { name: 'Release warning' }));

        expect(await screen.findByText('`rope-burn-42` is already cleared. You already did the soft thing.')).toBeTruthy();
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});
