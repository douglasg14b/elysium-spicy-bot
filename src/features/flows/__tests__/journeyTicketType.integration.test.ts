import type { Guild } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { TestDiscord, type ServerGuild } from '../../../shared/__tests__/support/testDiscord';
import { journeysRepo } from '../../provisioning/data/journeysRepo';
import { flowJourneyLinksRepo } from '../../provisioning/data/flowJourneyLinksRepo';
import { resourceBindingsRepo } from '../../provisioning/data/resourceBindingsRepo';
import { isPlanApplicable } from '../../provisioning/logic/installPlan';
import type { JourneyDeclaration, ResourceDeclaration } from '../../provisioning/logic/resourceDeclaration';
import { runInstall } from '../../provisioning/logic/runInstall';
import { registerResourceWriteBack } from '../../provisioning/resourceWriteBack';
import { installJourney, previewInstall, previewUnpublish, unpublishJourney } from '../../provisioning/provisioningService';
import { seedTicketCategorySlots } from '../../tickets/__tests__/support/ticketTestTables';
import { DEFAULT_TICKET_TYPES, defaultTicketTypes } from '../../tickets/data/defaultTicketTypes';
import { ticketingRepo } from '../../tickets/data/ticketingRepo';
import type { TicketTypeDefinition } from '../../tickets/data/ticketingSchema';
import { deleteTicketType, upsertTicketType } from '../../tickets/logic/setTicketTypes';
import { registerTicketTypeProvisioning } from '../../tickets/logic/ticketTypeProvisioning';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { flowsRepo } from '../data/flowsRepo';
import { applyResourcesToFlows } from '../logic/applyResourcesToFlows';

/**
 * A journey that declares a ticket type, end to end: the real install, uninstall and write-
 * back, the ticket feature's real provider registered as `initTicketsFeature` registers it,
 * real discord.js against TestDiscord, and the real migrated schema.
 *
 * The rule under test above all others is Douglas's (2026-10-10): **uninstalling a journey
 * never removes or changes a ticket type it installed** — it only forgets the row — and
 * install never changes a type that already exists. Every assertion about a type reads the
 * ticket settings back and compares the whole definition, so a rewrite that kept the label
 * but changed the template would still fail.
 *
 * Lives on the flows side because it wires a flow too; provisioning's own tests may not
 * import the ticket feature (`dependencyDirection.test.ts`).
 */

const SETTINGS: Omit<TicketTypeDefinition, 'type' | 'label'> = {
    nameTemplate: 'desk-{{####}}-{{subject}}',
    permissions: DEFAULT_TICKET_TYPES.verification.permissions,
    autoClaimOnOpen: false,
};

function ticketTypeResource(key: string, label: string, nameTemplate = SETTINGS.nameTemplate): ResourceDeclaration {
    return { key, kind: 'ticketType', defaultName: label, ticketType: { ...SETTINGS, nameTemplate } };
}

function journeyOf(journeyKey: string, resources: ResourceDeclaration[]): JourneyDeclaration {
    return { journeyKey, name: `Journey ${journeyKey}`, resources };
}

const running: TestDiscord[] = [];

interface Scenario {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly liveGuild: Guild;
}

beforeAll(async () => {
    await migrateTestDatabase();
    await ensureBlocksDiscovered();
    // What the boot roots do (`initTicketsFeature`, `initFlows`).
    registerTicketTypeProvisioning();
    registerResourceWriteBack(applyResourcesToFlows);
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

async function startScenario(): Promise<Scenario> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild({ bot: { permissions: ['ManageChannels', 'ManageRoles'] } });
    await discord.start();
    return { discord, guild, liveGuild: discord.clientGuild(guild) };
}

/**
 * A ticket config row with the seeded two types. `ready` adds what Open Ticket needs — a
 * deployed panel, three bound categories and a moderation role.
 */
async function seedTicketSettings(guildId: string, ready: boolean): Promise<void> {
    await ticketingRepo.upsert({
        guildId,
        config: {
            modTicketsDeployed: ready,
            modTicketsDeployedChannelId: ready ? '910000000000000001' : null,
            modTicketsDeployedMessageId: ready ? '910000000000000002' : null,
            moderationRoles: ready ? ['910000000000000003'] : [],
            ticketTypes: defaultTicketTypes(),
        },
        ticketNumberInc: 0,
        entityVersion: 1,
    });
    if (ready) {
        await seedTicketCategorySlots(guildId, {
            open: { name: 'Open', discordId: '920000000000000001', provenance: 'adopted' },
            claimed: { name: 'Claimed', discordId: '920000000000000002', provenance: 'adopted' },
            closed: { name: 'Closed', discordId: '920000000000000003', provenance: 'adopted' },
        });
    }
}

async function ticketTypes(guildId: string): Promise<Record<string, TicketTypeDefinition>> {
    return (await ticketingRepo.get(guildId))?.config.ticketTypes ?? {};
}

async function installClean(scenario: Scenario, journey: JourneyDeclaration) {
    const outcome = await runInstall({ guild: scenario.liveGuild, journey, staffRoleIds: [] });
    if (outcome.status !== 'applied') throw new Error(`install did not apply: ${outcome.status}`);
    expect(outcome.failure).toBeUndefined();
    return outcome;
}

async function uninstall(scenario: Scenario, journeyKey: string) {
    const plan = await previewUnpublish(scenario.liveGuild, journeyKey);
    const result = await unpublishJourney({ guild: scenario.liveGuild, approvedPlan: plan });
    return { plan, result };
}

describe('install', () => {
    it('creates a type the server does not have, from the declaration, and records it created', async () => {
        const scenario = await startScenario();
        await seedTicketSettings(scenario.guild.id, true);

        const outcome = await installClean(scenario, journeyOf('desk', [ticketTypeResource('desk-type', 'Front desk')]));

        expect(outcome.plan.items[0]).toMatchObject({ action: 'create', kind: 'ticketType' });
        expect((await ticketTypes(scenario.guild.id))['desk-type']).toEqual({ type: 'desk-type', label: 'Front desk', ...SETTINGS });
        expect(await resourceBindingsRepo.get(scenario.guild.id, 'desk', 'desk-type')).toMatchObject({
            kind: 'ticketType',
            state: 'created',
            discordId: 'desk-type',
            name: 'Front desk',
        });
    });

    it('adopts the seeded verification type and leaves it exactly as it was', async () => {
        const scenario = await startScenario();
        await seedTicketSettings(scenario.guild.id, true);
        const before = (await ticketTypes(scenario.guild.id)).verification;

        // A different label and template from the seeded type: neither may reach it.
        const outcome = await installClean(
            scenario,
            journeyOf('verify', [ticketTypeResource('verification', 'Prove yourself', 'proof-{{####}}')])
        );

        expect(outcome.plan.items[0]).toMatchObject({ action: 'adopt', name: 'Verification' });
        expect(outcome.plan.items[0]?.reason).toMatch(/used as it is/);
        expect((await ticketTypes(scenario.guild.id)).verification).toEqual(before);
        expect((await ticketTypes(scenario.guild.id)).verification).toMatchObject({
            label: 'Verification',
            nameTemplate: 'V{{####}}-{{subject}}',
        });
        expect(await resourceBindingsRepo.get(scenario.guild.id, 'verify', 'verification')).toMatchObject({
            state: 'adopted',
            name: 'Verification',
        });
    });

    it('records a type made between preview and apply as adopted, and does not touch it', async () => {
        // Sabotage-verified: creating through `upsertTicketType` instead writes the
        // journey's settings over the dashboard's type, and this fails.
        const scenario = await startScenario();
        await seedTicketSettings(scenario.guild.id, true);
        const journey = journeyOf('desk', [ticketTypeResource('desk-type', 'Front desk')]);
        const input = { guild: scenario.liveGuild, journey, staffRoleIds: [] };

        const plan = await previewInstall(input);
        expect(plan.items[0]).toMatchObject({ action: 'create' });

        const dashboardMade: TicketTypeDefinition = {
            type: 'desk-type',
            label: 'Made on the dashboard',
            nameTemplate: 'dash-{{####}}',
            permissions: DEFAULT_TICKET_TYPES.support.permissions,
            autoClaimOnOpen: true,
        };
        expect((await upsertTicketType({ guildId: scenario.guild.id, definition: dashboardMade })).ok).toBe(true);

        const result = await installJourney({ ...input, approvedPlan: plan });

        expect(result.failure).toBeUndefined();
        expect(result.applied).toEqual([
            { resourceKey: 'desk-type', discordId: 'desk-type', action: 'adopted', name: 'Made on the dashboard' },
        ]);
        expect((await ticketTypes(scenario.guild.id))['desk-type']).toEqual(dashboardMade);
        expect(await resourceBindingsRepo.get(scenario.guild.id, 'desk', 'desk-type')).toMatchObject({ state: 'adopted' });
    });

    it('blocks the whole install when the server has no ticket settings, and writes nothing', async () => {
        const scenario = await startScenario();
        const journey = journeyOf('desk', [
            ticketTypeResource('desk-type', 'Front desk'),
            { key: 'lobby', kind: 'textChannel', defaultName: 'lobby' },
        ]);

        const outcome = await runInstall({ guild: scenario.liveGuild, journey, staffRoleIds: [] });

        expect(outcome.status).toBe('notApplicable');
        const plan = outcome.status === 'notApplicable' ? outcome.plan : null;
        expect(plan?.items.find((item) => item.resourceKey === 'desk-type')).toMatchObject({ action: 'blocked' });
        expect(plan?.items.find((item) => item.resourceKey === 'desk-type')?.reason).toMatch(/no ticket settings/);
        // One blocked item stops everything: the channel beside it is not created either.
        expect(scenario.discord.requests.filter((request) => request.method === 'POST')).toEqual([]);
        expect(await resourceBindingsRepo.listByJourney(scenario.guild.id, 'desk')).toEqual([]);
    });

    it('notes, without blocking, a ticket system that is not fully set up', async () => {
        const scenario = await startScenario();
        await seedTicketSettings(scenario.guild.id, false);

        const plan = await previewInstall({
            guild: scenario.liveGuild,
            journey: journeyOf('desk', [ticketTypeResource('desk-type', 'Front desk')]),
            staffRoleIds: [],
        });

        expect(isPlanApplicable(plan)).toBe(true);
        expect(plan.items[0]?.note).toMatch(/isn't fully set up yet/);
        await installClean(scenario, journeyOf('desk', [ticketTypeResource('desk-type', 'Front desk')]));
        expect((await ticketTypes(scenario.guild.id))['desk-type']).toBeDefined();
    });

    it('lets two journeys share one type: the first creates it, the second uses it as it is', async () => {
        const scenario = await startScenario();
        await seedTicketSettings(scenario.guild.id, true);

        await installClean(scenario, journeyOf('first', [ticketTypeResource('desk-type', 'Front desk')]));
        const second = await installClean(
            scenario,
            journeyOf('second', [ticketTypeResource('desk-type', 'Another label', 'other-{{####}}')])
        );

        expect(second.applied).toEqual([
            { resourceKey: 'desk-type', discordId: 'desk-type', action: 'adopted', name: 'Front desk' },
        ]);
        expect((await ticketTypes(scenario.guild.id))['desk-type']).toEqual({ type: 'desk-type', label: 'Front desk', ...SETTINGS });
        expect(await resourceBindingsRepo.get(scenario.guild.id, 'first', 'desk-type')).toMatchObject({ state: 'created' });
        expect(await resourceBindingsRepo.get(scenario.guild.id, 'second', 'desk-type')).toMatchObject({ state: 'adopted' });
    });

    it('makes a type again when the one this journey installed has gone', async () => {
        const scenario = await startScenario();
        await seedTicketSettings(scenario.guild.id, true);
        const journey = journeyOf('desk', [ticketTypeResource('desk-type', 'Front desk')]);
        await installClean(scenario, journey);

        // Gone by a hand edit — the dashboard would have refused, since the journey holds it.
        await ticketingRepo.mutateConfig(scenario.guild.id, (current) => {
            const remaining = { ...current.config.ticketTypes };
            delete remaining['desk-type'];
            return { ...current.config, ticketTypes: remaining };
        });

        const again = await installClean(scenario, journey);

        expect(again.plan.items[0]).toMatchObject({ action: 'create' });
        expect(again.plan.items[0]?.reason).toMatch(/made again/);
        expect((await ticketTypes(scenario.guild.id))['desk-type']).toEqual({ type: 'desk-type', label: 'Front desk', ...SETTINGS });
    });
});

describe('uninstall', () => {
    it('leaves the type, its tickets and a flow using it exactly as they were, and only forgets the row', async () => {
        // Sabotage-verified: letting a ticket type fall past its branch in
        // `buildUnpublishPlan` reaches the delete path and fails this, and the unit tests.
        const scenario = await startScenario();
        const guildId = scenario.guild.id;
        await seedTicketSettings(guildId, true);
        const journey = journeyOf('desk', [
            ticketTypeResource('desk-type', 'Front desk'),
            { key: 'lobby', kind: 'textChannel', defaultName: 'lobby' },
        ]);
        await journeysRepo.create({ guildId, journeyKey: 'desk', name: 'Front Desk', resources: journey.resources });

        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'join', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
                { id: 'open', type: 'action.openTicket', position: { x: 0, y: 160 }, data: { title: 'Welcome', ticketTypeKey: 'desk-type' } },
            ],
            edges: [{ id: 'join-open', source: 'join', target: 'open' }],
        };
        const flow = await flowsRepo.create({ guildId, name: 'Desk', graph, enabled: false });
        await flowJourneyLinksRepo.attach({ guildId, flowId: flow.flowId, journeyKey: 'desk' });

        const installed = await installClean(scenario, journey);
        // Write-back filled the type in.
        expect(installed.writeBack.updatedFlowIds).toEqual([flow.flowId]);
        const wired = await flowsRepo.getByFlowId(flow.flowId);
        expect(wired?.graph.nodes[1]?.data).toMatchObject({ ticketType: 'desk-type', ticketTypeKey: 'desk-type' });

        await database
            .insertInto('tickets')
            .values({
                guildId,
                ticketNumber: 1,
                type: 'desk-type',
                status: 'open',
                subjectId: 'subject-1',
                openerId: null,
                claimerId: null,
                channelId: '930000000000000001',
                title: 'Hello',
                reason: 'because',
                openedAt: new Date().toISOString(),
            } as never)
            .execute();
        const ticketBefore = await database.selectFrom('tickets').selectAll().where('guildId', '=', guildId).execute();
        const typeBefore = (await ticketTypes(guildId))['desk-type'];
        const lobbyId = installed.applied.find((entry) => entry.resourceKey === 'lobby')?.discordId;
        if (!lobbyId) throw new Error('the install bound no lobby channel');
        const lobby = scenario.guild.channel(lobbyId);

        const { plan, result } = await uninstall(scenario, 'desk');

        const typeItem = plan.items.find((item) => item.resourceKey === 'desk-type');
        expect(typeItem).toMatchObject({ action: 'forget', kind: 'ticketType' });
        expect(typeItem?.explanation).toMatch(/stays, and flows that use it keep working/);
        expect(result.results.find((entry) => entry.resourceKey === 'desk-type')?.outcome).toBe('forgotten');

        expect((await ticketTypes(guildId))['desk-type']).toEqual(typeBefore);
        expect(await database.selectFrom('tickets').selectAll().where('guildId', '=', guildId).execute()).toEqual(ticketBefore);
        expect((await flowsRepo.getByFlowId(flow.flowId))?.graph).toEqual(wired?.graph);
        expect(await resourceBindingsRepo.get(guildId, 'desk', 'desk-type')).toBeNull();
        // The channel the journey created is deleted, as uninstall always did.
        expect(lobby.exists).toBe(false);
    });
});

describe('a key that changes from ticket type to channel', () => {
    it('records the channel install makes as a channel, so uninstall deletes it — and the type stays', async () => {
        // The panel can reach this in two steps: remove the ticket type row, add a channel
        // whose key follows its name back to the same key. Sabotage-verified: without
        // `kind` in `rebind`, the row stays labelled a ticket type and uninstall forgets
        // the channel this journey created instead of deleting it.
        const scenario = await startScenario();
        const guildId = scenario.guild.id;
        await seedTicketSettings(guildId, true);
        await installClean(scenario, journeyOf('desk', [ticketTypeResource('front-desk', 'Front desk')]));
        const typeBefore = (await ticketTypes(guildId))['front-desk'];

        const asChannel = await installClean(
            scenario,
            journeyOf('desk', [{ key: 'front-desk', kind: 'textChannel', defaultName: 'front-desk' }])
        );
        expect(asChannel.plan.items[0]).toMatchObject({ action: 'create', kind: 'textChannel' });
        // Planned as new, not as "the previously bound channel no longer exists".
        expect(asChannel.plan.items[0]?.reason).toBeUndefined();
        const channelId = asChannel.applied[0]?.discordId;
        if (!channelId) throw new Error('the install made no channel');
        expect(await resourceBindingsRepo.get(guildId, 'desk', 'front-desk')).toMatchObject({
            kind: 'textChannel',
            state: 'created',
            discordId: channelId,
        });

        const channel = scenario.guild.channel(channelId);
        const { plan } = await uninstall(scenario, 'desk');
        expect(plan.items[0]).toMatchObject({ action: 'delete', kind: 'textChannel' });
        expect(channel.exists).toBe(false);
        expect((await ticketTypes(guildId))['front-desk']).toEqual(typeBefore);
    });
});

describe('the dashboard and a type a journey holds', () => {
    it('refuses to delete it, naming the journey; after uninstall the delete goes through, and install makes it again', async () => {
        const scenario = await startScenario();
        const guildId = scenario.guild.id;
        await seedTicketSettings(guildId, true);
        const journey = journeyOf('desk', [ticketTypeResource('desk-type', 'Front desk')]);
        await journeysRepo.create({ guildId, journeyKey: 'desk', name: 'Front Desk', resources: journey.resources });
        await installClean(scenario, journey);

        const refused = await deleteTicketType(guildId, 'desk-type');
        expect(refused).toMatchObject({ ok: false, reason: 'held-by-journey' });
        expect(refused.ok === false && refused.message).toMatch(/journey "Front Desk"/);
        expect((await ticketTypes(guildId))['desk-type']).toBeDefined();

        await uninstall(scenario, 'desk');
        expect((await deleteTicketType(guildId, 'desk-type')).ok).toBe(true);
        expect((await ticketTypes(guildId))['desk-type']).toBeUndefined();

        const again = await installClean(scenario, journey);
        expect(again.plan.items[0]).toMatchObject({ action: 'create' });
        expect((await ticketTypes(guildId))['desk-type']).toEqual({ type: 'desk-type', label: 'Front desk', ...SETTINGS });
    });
});
