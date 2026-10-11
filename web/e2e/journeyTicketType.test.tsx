import { screen, waitFor, within } from '@testing-library/react';
import type { PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TICKET_TYPES, defaultTicketTypes } from '../../src/features/tickets/data/defaultTicketTypes';
import { ticketingRepo } from '../../src/features/tickets/data/ticketingRepo';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * A flow's journey declaring a ticket type, end to end: declared through the resources
 * route, installed through the install route — the ticket feature's real provider behind
 * it, registered by the dashboard boot as `initTicketsFeature` registers it — seen on the
 * ticket settings page, then uninstalled from the flows list's inventory dialog.
 *
 * The promise under test is Douglas's (2026-10-10): uninstalling a journey never removes a
 * ticket type it installed. The dialog has to say so before the click, offer the uninstall
 * even though nothing would be deleted, and the type has to be on the settings page after.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const FLOW_NAME = 'Front desk intake';
const DIALOG_NAME = `What ${FLOW_NAME} has in your server`;

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

describe('a journey that declares a ticket type', () => {
    it('installs the type, shows it on the ticket settings page, and leaves it there on uninstall', async () => {
        const discord = new TestDiscord();
        running.push(discord);
        const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
        const client = await discord.start();

        // Ticket settings exist but are not fully set up: the install notes that and
        // goes ahead, which is the case this step meets.
        await ticketingRepo.upsert({
            guildId: guild.id,
            config: {
                modTicketsDeployed: false,
                modTicketsDeployedChannelId: null,
                modTicketsDeployedMessageId: null,
                moderationRoles: [],
                ticketTypes: defaultTicketTypes(),
            },
            ticketNumberInc: 0,
            entityVersion: 1,
        });

        const faults: string[] = [];
        const api = createSeedApi(
            buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }),
            discord
        );
        const guildPath = `/api/guilds/${guild.id}`;
        const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: FLOW_NAME });
        await api.send('PUT', `${guildPath}/flows/${flow.flowId}/resources`, {
            resources: [
                {
                    key: 'front-desk',
                    kind: 'ticketType',
                    defaultName: 'Front desk',
                    ticketType: {
                        nameTemplate: 'desk-{{####}}-{{subject}}',
                        permissions: DEFAULT_TICKET_TYPES.verification.permissions,
                        autoClaimOnOpen: false,
                    },
                },
            ],
        });
        const installed = await api.send<{ applied: { resourceKey: string; action: string }[] }>(
            'POST',
            `${guildPath}/flows/${flow.flowId}/install`,
            {}
        );
        expect(faults).toEqual([]);
        expect(installed.applied).toEqual([expect.objectContaining({ resourceKey: 'front-desk', action: 'created' })]);
        const typeAsInstalled = (await ticketingRepo.get(guild.id))?.config.ticketTypes?.['front-desk'];
        expect(typeAsInstalled).toMatchObject({ label: 'Front desk', nameTemplate: 'desk-{{####}}-{{subject}}' });

        installDashboardApi(client, OPERATOR);

        // The ticket settings page lists it like any type an operator made there.
        const settings = renderDashboard('/tickets/config');
        expect(await screen.findByText('Front desk')).toBeTruthy();
        settings.unmount();

        // The inventory says the type stays, and still offers the uninstall that forgets it.
        const { user } = renderDashboard('/flows');
        const row = await flowRow(FLOW_NAME);
        await user.click(within(row).getByRole('button', { name: `Manage what ${FLOW_NAME} published` }));
        const dialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
        expect(await within(dialog).findByText('Settings this flow installed')).toBeTruthy();
        expect(within(dialog).getByText(/stays, and flows that use it keep working/)).toBeTruthy();

        await user.click(within(dialog).getByRole('button', { name: 'Uninstall, keeping 1 setting' }));
        await user.click(within(dialog).getByRole('button', { name: 'Yes, uninstall' }));

        // Only the record went: the dialog re-reads to nothing, the type is untouched.
        expect(
            await within(dialog).findByText('Nothing live in the server yet. Install it from the builder first.')
        ).toBeTruthy();
        await waitFor(async () =>
            expect((await ticketingRepo.get(guild.id))?.config.ticketTypes?.['front-desk']).toEqual(typeAsInstalled)
        );

        await user.click(within(dialog).getByRole('button', { name: 'Done' }));
        expect(await within(await flowRow(FLOW_NAME)).findByText('Not installed')).toBeTruthy();
    });
});
