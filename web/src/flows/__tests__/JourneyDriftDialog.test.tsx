import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DriftedResource, JourneyDrift } from '../../api/types';
import { installFakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { JourneyDriftDialog } from '../JourneyDriftDialog';

/**
 * The drift dialog against a fake of the bot's API.
 *
 * What the server decides — which resources drifted, which may be repaired — is covered
 * by the provisioning integration suite against TestDiscord. This covers what the
 * dialog does with the answer: what it offers, what it sends back, and what it claims
 * when it could not find out.
 */

const DRIFT_PATH = '/api/guilds/g1/journeys/onboarding/drift';
const REPAIR_PATH = '/api/guilds/g1/journeys/onboarding/repair';

function drifted(overrides: Partial<DriftedResource> & Pick<DriftedResource, 'resourceKey'>): DriftedResource {
    return {
        name: overrides.resourceKey,
        kind: 'textChannel',
        drift: [{ kind: 'renamed', explanation: `Renamed in Discord.` }],
        repairable: true,
        ...overrides,
    };
}

function report(overrides: Partial<JourneyDrift> = {}): JourneyDrift {
    return {
        journeyKey: 'onboarding',
        drifted: [],
        cleanKeys: [],
        unchecked: [],
        orphans: [],
        ...overrides,
    };
}

function renderDialog() {
    return renderWithProviders(
        <JourneyDriftDialog
            opened
            onClose={() => undefined}
            guildId="g1"
            journeyKey="onboarding"
            journeyName="Onboarding"
        />
    );
}

describe('JourneyDriftDialog', () => {
    it('repairs only what the server says may be repaired, then shows the re-read', async () => {
        const api = installFakeApi();
        api.on('GET', DRIFT_PATH, () => ({
            body: report({
                drifted: [
                    drifted({ resourceKey: 'welcome' }),
                    drifted({ resourceKey: 'rules', repairable: false }),
                ],
                cleanKeys: ['staff'],
            }),
        }));
        api.on('POST', REPAIR_PATH, () => {
            // The server's next answer is the repaired guild.
            api.on('GET', DRIFT_PATH, () => ({
                body: report({
                    drifted: [drifted({ resourceKey: 'rules', repairable: false })],
                    cleanKeys: ['staff', 'welcome'],
                }),
            }));
            return {
                body: {
                    results: [
                        { resourceKey: 'welcome', kind: 'textChannel', name: 'welcome', outcome: 'repaired', repaired: ['renamed'] },
                    ],
                },
            };
        });

        const { user } = renderDialog();

        // The adopted one is shown and explained, and not counted in the offer.
        expect(await screen.findByText('left alone')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Repair 1 resource' }));

        expect(api.requests.find((request) => request.method === 'POST')?.body).toEqual({
            resourceKeys: ['welcome'],
        });
        // Nothing repairable remains, so the button goes rather than offering zero.
        expect(await screen.findByText('rules')).toBeTruthy();
        expect(screen.queryByText('welcome')).toBeNull();
        expect(screen.queryByRole('button', { name: /^Repair/ })).toBeNull();
    });

    it('says the check failed rather than showing a clean report', async () => {
        const api = installFakeApi();
        api.on('GET', DRIFT_PATH, () => ({ status: 502, body: { error: 'Discord did not answer.' } }));

        renderDialog();

        expect(await screen.findByText('Discord did not answer. Close this and try again.')).toBeTruthy();
        expect(screen.queryByText(/exactly as declared/)).toBeNull();
    });

    it('offers no repair when everything drifted was adopted', async () => {
        const api = installFakeApi();
        api.on('GET', DRIFT_PATH, () => ({
            body: report({ drifted: [drifted({ resourceKey: 'rules', repairable: false })] }),
        }));

        renderDialog();

        expect(await screen.findByText(/adopted rather than created here/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Repair/ })).toBeNull();
    });
});
