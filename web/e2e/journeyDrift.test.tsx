import { screen } from '@testing-library/react';
import type { Client, PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrateTestDatabase } from '../../src/features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { guildSettingsRepo } from '../../src/features-system/guild-settings';
import { journeysRepo } from '../../src/features/provisioning/data/journeysRepo';
import type { JourneyDeclaration } from '../../src/features/provisioning/logic/resourceDeclaration';
import { installJourney, previewInstall } from '../../src/features/provisioning/provisioningService';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerRole,
} from '../../src/shared/__tests__/support/testDiscord';
import { renderWithProviders } from '../src/__tests__/support/renderWithProviders';
import { JourneyDriftDialog } from '../src/flows/JourneyDriftDialog';
import { installDashboardApi } from './support/dashboardApi';

/**
 * The drift dialog, end to end: the real component, the real API routes, the real
 * provisioning engine and database, and real discord.js against TestDiscord.
 *
 * Each scenario starts from a real install and has an operator change something in
 * Discord, then works the dialog the way an operator would. Assertions land on two
 * sides: what the dialog shows, and what Discord holds afterwards.
 *
 * The component suite covers what the dialog does with an answer. This covers whether
 * the answer is right at the moment the dialog asks, which only exists when all the
 * layers run together.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const JOURNEY_KEY = 'lobby';

const LOBBY: JourneyDeclaration = {
    journeyKey: JOURNEY_KEY,
    name: 'Lobby',
    resources: [
        {
            key: 'lobby-category',
            kind: 'category',
            defaultName: 'Lobby',
            permissions: [
                { audience: 'everyone', access: 'hidden' },
                { audience: 'staff', access: 'readWrite' },
            ],
        },
        {
            key: 'welcome-channel',
            kind: 'textChannel',
            defaultName: 'welcome',
            parentKey: 'lobby-category',
            permissions: [
                { audience: 'everyone', access: 'readOnly' },
                { audience: 'staff', access: 'readWrite' },
            ],
        },
    ],
};

const CLEAN = 'All 2 things this journey installed are still exactly as declared.';

interface InstalledLobby {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly staff: ServerRole;
    readonly welcome: ServerChannel;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await migrateTestDatabase();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A guild with the lobby journey saved and installed, the way the dashboard leaves it. */
async function installLobby(): Promise<InstalledLobby> {
    const discord = new TestDiscord();
    running.push(discord);

    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    const staff = guild.createRole({ name: 'Staff' });
    const client = await discord.start();
    const liveGuild = discord.clientGuild(guild);

    await guildSettingsRepo.setStaffRoleIds(guild.id, [staff.id]);
    await journeysRepo.create({
        guildId: guild.id,
        journeyKey: LOBBY.journeyKey,
        name: LOBBY.name,
        resources: LOBBY.resources,
    });

    const input = { guild: liveGuild, journey: LOBBY, staffRoleIds: [staff.id] };
    const plan = await previewInstall(input);
    const result = await installJourney({ ...input, approvedPlan: plan });
    expect(result.failure).toBeUndefined();

    const welcomeId = result.applied.find((entry) => entry.resourceKey === 'welcome-channel')?.discordId;
    if (!welcomeId) throw new Error('The install created no welcome channel.');
    // Install's own overwrite writes announce themselves; settle them before the scenario.
    discord.flushGateway();

    return { discord, client, guild, staff, welcome: guild.channel(welcomeId) };
}

function openDialog(lobby: InstalledLobby) {
    installDashboardApi(lobby.client);
    return renderWithProviders(
        <JourneyDriftDialog
            opened
            onClose={() => undefined}
            guildId={lobby.guild.id}
            journeyKey={JOURNEY_KEY}
            journeyName="Lobby"
            subject="journey"
        />
    );
}

describe('the drift dialog against real routes and TestDiscord', () => {
    it('reports an untouched install as clean', async () => {
        const lobby = await installLobby();

        openDialog(lobby);

        expect(await screen.findByText(CLEAN)).toBeTruthy();
    });

    it('renames a channel back after someone renamed it in Discord, and then reads clean', async () => {
        const lobby = await installLobby();
        lobby.welcome.rename('general-chat');

        const { user } = openDialog(lobby);
        await user.click(await screen.findByRole('button', { name: 'Repair 1 resource' }));

        expect(await screen.findByText(CLEAN)).toBeTruthy();
        expect(lobby.welcome.name).toBe('welcome');
    });

    it('puts a stripped overwrite back, and then reads clean', async () => {
        const lobby = await installLobby();
        lobby.welcome.removeOverwrite(lobby.guild.everyone);

        const { user } = openDialog(lobby);
        await user.click(await screen.findByRole('button', { name: 'Repair 1 resource' }));

        // Discord holds the repair...
        await expect.poll(() => lobby.welcome.overwriteFor(lobby.guild.everyone)).toBeTruthy();
        // ...and the dialog, re-reading straight after, says so.
        expect(await screen.findByText(CLEAN)).toBeTruthy();
    });
});
