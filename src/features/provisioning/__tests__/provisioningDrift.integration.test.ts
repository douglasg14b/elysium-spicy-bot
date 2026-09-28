import {
    ChannelType,
    PermissionFlagsBits,
    RESTJSONErrorCodes,
    type Guild,
    type PermissionsString,
} from 'discord.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    TestDiscord,
    type OverwriteView,
    type ServerChannel,
    type ServerGuild,
    type ServerRole,
} from '../../../shared/__tests__/support/testDiscord';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import type { ApplyDriftRepairResult } from '../logic/applyDriftRepair';
import type { ApplyInstallPlanResult } from '../logic/applyInstallPlan';
import { declaredRoleReference } from '../logic/declaredRoleReference';
import type { ResourceChoice } from '../logic/installPlan';
import type { JourneyDriftPlan } from '../logic/journeyDriftPlan';
import type { JourneyDeclaration } from '../logic/resourceDeclaration';
import { createProvisioningTestDb, withinDeadlockTimeout } from './support/provisioningTestDb';

/**
 * Install, drift detection and drift repair, composed — against real discord.js and a
 * real `resource_bindings` table.
 *
 * Every scenario drives the public service functions the web routes call
 * (`previewInstall`, `installJourney`, `previewDrift`, `repairDrift`) and starts from a
 * real install through them, never from hand-inserted binding rows. The unit tests pin
 * each of those operations alone; what they cannot see is whether two correct operations
 * are still correct in sequence, which is where every live session has found its bugs.
 *
 * Assertions about Discord are made on TestDiscord's **server-side handles** — what
 * Discord holds — not on the client's cache, because the cache can agree with the code
 * that filled it while the server does not.
 *
 * "Renaming in the panel" is modelled the way the product models it: the next call is
 * handed a declaration whose `defaultName` changed.
 *
 * A re-check after a **permission** repair flushes the gateway first. Discord answers that
 * PUT with a bare 204, so the client's cache learns of the change only from the gateway
 * event, and TestDiscord holds REST-caused events back until asked. `previewDrift` no
 * longer depends on that event — it refetches the guild's channels before comparing —
 * so the flush settles the cache for the assertions here rather than for the check.
 * `web/e2e/journeyDrift.test.tsx` is the test that re-reads with no flush, as the
 * dialog does.
 */

const testDb = await createProvisioningTestDb();

vi.mock('../../../features-system/data-persistence/database', () => ({
    get database() {
        return testDb.db;
    },
}));

const { installJourney, previewDrift, previewInstall, repairDrift } = await import('../provisioningService');
const { resourceBindingsRepo } = await import('../data/resourceBindingsRepo');

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];

/** What `readWrite` compiles to, as flag names in the handles' sorted order. */
const READ_WRITE: readonly PermissionsString[] = ['AddReactions', 'SendMessages', 'SendMessagesInThreads', 'ViewChannel'];
/** What `readOnly` denies. */
const POSTING: readonly PermissionsString[] = ['AddReactions', 'SendMessages', 'SendMessagesInThreads'];

const LOBBY = 'lobby';
const CATEGORY_KEY = 'lobby-category';
const WELCOME_KEY = 'welcome-channel';

/**
 * A category hidden from everyone, and a read-only channel inside it.
 *
 * The two permission models differ on purpose. A reparent that synced the channel to its
 * category would replace one with the other, and a fixture where they matched could not
 * tell that from a correct move.
 */
function lobbyJourney(welcomeName = 'welcome'): JourneyDeclaration {
    return {
        journeyKey: LOBBY,
        name: 'Lobby',
        resources: [
            {
                key: CATEGORY_KEY,
                kind: 'category',
                defaultName: 'Lobby',
                permissions: [
                    { audience: 'everyone', access: 'hidden' },
                    { audience: 'staff', access: 'readWrite' },
                ],
            },
            {
                key: WELCOME_KEY,
                kind: 'textChannel',
                defaultName: welcomeName,
                parentKey: CATEGORY_KEY,
                permissions: [
                    { audience: 'everyone', access: 'readOnly' },
                    { audience: 'staff', access: 'readWrite' },
                ],
            },
        ],
    };
}

interface Scenario {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly staff: ServerRole;
    readonly liveGuild: Guild;
}

const running: TestDiscord[] = [];

beforeEach(async () => {
    await testDb.db.deleteFrom('resource_bindings').execute();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

afterAll(async () => {
    await testDb.db.destroy();
});

async function startScenario(): Promise<Scenario> {
    const discord = new TestDiscord();
    running.push(discord);

    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    const staff = guild.createRole({ name: 'Staff' });
    await discord.start();

    return { discord, guild, staff, liveGuild: discord.clientGuild(guild) };
}

/** Preview then apply, exactly as `runInstall` does, and insist the install was clean. */
async function install(
    scenario: Scenario,
    journey: JourneyDeclaration,
    choices?: Readonly<Record<string, ResourceChoice>>
): Promise<ApplyInstallPlanResult> {
    const input = { guild: scenario.liveGuild, journey, choices, staffRoleIds: [scenario.staff.id] };

    const plan = await withinDeadlockTimeout(previewInstall(input), 'previewInstall');
    expect(plan.blockers).toEqual([]);
    expect(plan.items.filter((item) => item.action === 'blocked')).toEqual([]);

    const result = await withinDeadlockTimeout(installJourney({ ...input, approvedPlan: plan }), 'installJourney');
    expect(result.failure).toBeUndefined();
    return result;
}

async function checkDrift(scenario: Scenario, journey: JourneyDeclaration): Promise<JourneyDriftPlan> {
    return withinDeadlockTimeout(
        previewDrift({ guild: scenario.liveGuild, journey, staffRoleIds: [scenario.staff.id] }),
        'previewDrift'
    );
}

async function repair(
    scenario: Scenario,
    journey: JourneyDeclaration,
    approvedPlan: JourneyDriftPlan,
    approvedKeys: readonly string[]
): Promise<ApplyDriftRepairResult> {
    return withinDeadlockTimeout(
        repairDrift({
            guild: scenario.liveGuild,
            journey,
            staffRoleIds: [scenario.staff.id],
            approvedPlan,
            approvedKeys: new Set(approvedKeys),
        }),
        'repairDrift'
    );
}

/** The server-side handle for a channel an install bound to `resourceKey`. */
function installedChannel(scenario: Scenario, result: ApplyInstallPlanResult, resourceKey: string): ServerChannel {
    const applied = result.applied.find((entry) => entry.resourceKey === resourceKey);
    if (!applied) throw new Error(`The install bound nothing to "${resourceKey}".`);
    return scenario.guild.channel(applied.discordId);
}

async function bindingFor(
    scenario: Scenario,
    journeyKey: string,
    resourceKey: string
): Promise<ResourceBindingEntity | null> {
    return withinDeadlockTimeout(
        resourceBindingsRepo.get(scenario.guild.id, journeyKey, resourceKey),
        'resourceBindingsRepo.get'
    );
}

function byId(left: OverwriteView, right: OverwriteView): number {
    return left.id.localeCompare(right.id);
}

/** Overwrites compared as a set: the order Discord stores them in is not a property. */
function expectOverwrites(channel: ServerChannel, expected: readonly OverwriteView[]): void {
    expect([...channel.overwrites].sort(byId)).toEqual([...expected].sort(byId));
}

describe('provisioning drift, composed against TestDiscord', () => {
    it('1. a fresh install is clean: Discord holds what was declared, and drift agrees', async () => {
        const scenario = await startScenario();
        const { guild, staff } = scenario;
        const journey = lobbyJourney();

        const result = await install(scenario, journey);

        expect(result.applied.map((entry) => [entry.resourceKey, entry.action])).toEqual([
            [CATEGORY_KEY, 'created'],
            [WELCOME_KEY, 'created'],
        ]);

        const category = installedChannel(scenario, result, CATEGORY_KEY);
        expect(category.type).toBe(ChannelType.GuildCategory);
        expect(category.name).toBe('Lobby');
        expect(category.parentId).toBeNull();
        expectOverwrites(category, [
            { id: guild.everyone.id, type: 'role', allow: [], deny: ['ViewChannel'] },
            { id: staff.id, type: 'role', allow: READ_WRITE, deny: [] },
            // The bot is always granted access to what it creates, as a member overwrite.
            { id: guild.bot.id, type: 'member', allow: READ_WRITE, deny: [] },
        ]);

        const welcome = installedChannel(scenario, result, WELCOME_KEY);
        expect(welcome.type).toBe(ChannelType.GuildText);
        expect(welcome.name).toBe('welcome');
        expect(welcome.parentId).toBe(category.id);
        expectOverwrites(welcome, [
            { id: guild.everyone.id, type: 'role', allow: ['ViewChannel'], deny: POSTING },
            { id: staff.id, type: 'role', allow: READ_WRITE, deny: [] },
            { id: guild.bot.id, type: 'member', allow: READ_WRITE, deny: [] },
        ]);

        expect(await bindingFor(scenario, LOBBY, CATEGORY_KEY)).toMatchObject({
            state: 'created',
            discordId: category.id,
            name: 'Lobby',
        });
        expect(await bindingFor(scenario, LOBBY, WELCOME_KEY)).toMatchObject({
            state: 'created',
            discordId: welcome.id,
            name: 'welcome',
        });

        // The claim that matters most: install and drift detection agree about what an
        // untouched install looks like.
        const drift = await checkDrift(scenario, journey);
        expect(drift.drifted).toEqual([]);
        expect(drift.unchecked).toEqual([]);
        expect([...drift.cleanKeys].sort()).toEqual([CATEGORY_KEY, WELCOME_KEY]);
    });

    it('2. a rename in the panel is drift, repair applies it on Discord, and a re-check is clean', async () => {
        const scenario = await startScenario();
        const result = await install(scenario, lobbyJourney());
        const welcome = installedChannel(scenario, result, WELCOME_KEY);
        const renamed = lobbyJourney('welcome-mat');

        const drift = await checkDrift(scenario, renamed);
        expect(drift.drifted).toHaveLength(1);
        expect(drift.drifted[0]).toMatchObject({
            resourceKey: WELCOME_KEY,
            repairable: true,
            drift: [{ kind: 'renamed', declared: 'welcome-mat', actual: 'welcome' }],
        });

        const repaired = await repair(scenario, renamed, drift, [WELCOME_KEY]);
        expect(repaired.refusal).toBeUndefined();
        expect(repaired.results).toEqual([
            expect.objectContaining({ resourceKey: WELCOME_KEY, outcome: 'repaired', repaired: ['renamed'] }),
        ]);

        expect(welcome.name).toBe('welcome-mat');
        expect(await bindingFor(scenario, LOBBY, WELCOME_KEY)).toMatchObject({ name: 'welcome-mat' });
        expect((await checkDrift(scenario, renamed)).drifted).toEqual([]);
    });

    it('3. a rename in Discord is drift, repair restores the declared name, and a re-check is clean', async () => {
        const scenario = await startScenario();
        const journey = lobbyJourney();
        const result = await install(scenario, journey);
        const welcome = installedChannel(scenario, result, WELCOME_KEY);

        welcome.rename('general');

        const drift = await checkDrift(scenario, journey);
        expect(drift.drifted).toHaveLength(1);
        expect(drift.drifted[0]).toMatchObject({
            resourceKey: WELCOME_KEY,
            drift: [{ kind: 'renamed', declared: 'welcome', actual: 'general' }],
        });

        const repaired = await repair(scenario, journey, drift, [WELCOME_KEY]);
        expect(repaired.results).toEqual([
            expect.objectContaining({ resourceKey: WELCOME_KEY, outcome: 'repaired', repaired: ['renamed'] }),
        ]);

        expect(welcome.name).toBe('welcome');
        expect(await bindingFor(scenario, LOBBY, WELCOME_KEY)).toMatchObject({ name: 'welcome' });
        expect((await checkDrift(scenario, journey)).drifted).toEqual([]);
    });

    it('4. repairing an unrelated move keeps a panel rename, restores the category, and leaves overwrites alone', async () => {
        const scenario = await startScenario();
        const result = await install(scenario, lobbyJourney());
        const category = installedChannel(scenario, result, CATEGORY_KEY);
        const welcome = installedChannel(scenario, result, WELCOME_KEY);
        const overwritesAtInstall = welcome.overwrites;
        const renamed = lobbyJourney('welcome-mat');

        welcome.moveTo(null);

        const drift = await checkDrift(scenario, renamed);
        expect(drift.drifted).toHaveLength(1);
        expect(drift.drifted[0]?.drift).toEqual([
            { kind: 'renamed', declared: 'welcome-mat', actual: 'welcome' },
            { kind: 'reparented', declaredParentId: category.id, actualParentId: null },
        ]);

        const writesBeforeRepair = scenario.discord.writesTo(welcome).length;
        const repaired = await repair(scenario, renamed, drift, [WELCOME_KEY]);
        expect(repaired.results).toEqual([
            expect.objectContaining({ outcome: 'repaired', repaired: ['renamed', 'reparented'] }),
        ]);

        expect(welcome.name).toBe('welcome-mat');
        expect(welcome.parentId).toBe(category.id);
        expectOverwrites(welcome, overwritesAtInstall);

        // On the wire: the move asked Discord *not* to sync the channel to its category,
        // and no write in the repair replaced the overwrite set.
        const repairWrites = scenario.discord.writesTo(welcome).slice(writesBeforeRepair);
        expect(repairWrites).toContainEqual(
            expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ lock_permissions: false }) })
        );
        for (const request of repairWrites) {
            expect(request.body).not.toHaveProperty('permission_overwrites');
        }

        expect((await checkDrift(scenario, renamed)).drifted).toEqual([]);
    });

    it('5. an adopted channel reports nothing, and its later rename is reported but never repaired', async () => {
        const scenario = await startScenario();
        const lounge = scenario.guild.createTextChannel({ name: 'lounge' });
        const journey: JourneyDeclaration = {
            journeyKey: 'hangout',
            name: 'Hangout',
            resources: [{ key: 'hangout-channel', kind: 'textChannel', defaultName: 'hangout' }],
        };

        const result = await install(scenario, journey, { 'hangout-channel': { adoptDiscordId: lounge.id } });
        expect(result.applied).toEqual([
            expect.objectContaining({ resourceKey: 'hangout-channel', discordId: lounge.id, action: 'adopted' }),
        ]);
        expect(lounge.name).toBe('lounge');
        expect(await bindingFor(scenario, 'hangout', 'hangout-channel')).toMatchObject({
            state: 'adopted',
            name: 'lounge',
        });

        // The declaration says "hangout" and Discord says "lounge", forever, by promise.
        // That is not drift.
        const quiet = await checkDrift(scenario, journey);
        expect(quiet.drifted).toEqual([]);
        expect(quiet.cleanKeys).toEqual(['hangout-channel']);

        lounge.rename('chill-zone');

        const drift = await checkDrift(scenario, journey);
        expect(drift.drifted).toEqual([
            expect.objectContaining({
                resourceKey: 'hangout-channel',
                repairable: false,
                drift: [{ kind: 'renamed', declared: 'lounge', actual: 'chill-zone' }],
            }),
        ]);

        const refused = await repair(scenario, journey, drift, ['hangout-channel']);
        expect(refused.results).toEqual([expect.objectContaining({ outcome: 'refused' })]);

        expect(lounge.name).toBe('chill-zone');
        expect(scenario.discord.writesTo(lounge)).toEqual([]);
    });

    it('5b. a plan claiming an adopted channel is repairable is still refused, with nothing written', async () => {
        const scenario = await startScenario();
        const lounge = scenario.guild.createTextChannel({ name: 'lounge' });
        const journey: JourneyDeclaration = {
            journeyKey: 'hangout',
            name: 'Hangout',
            resources: [{ key: 'hangout-channel', kind: 'textChannel', defaultName: 'hangout' }],
        };
        await install(scenario, journey, { 'hangout-channel': { adoptDiscordId: lounge.id } });
        lounge.rename('chill-zone');

        const drift = await checkDrift(scenario, journey);
        /*
         * Defence in depth rather than a live threat: the `/repair` route rebuilds the plan
         * on the server and never accepts one from the browser. What is under test is
         * `repairDrift`'s own promise not to trust a `repairable` flag that travelled —
         * any future caller handing it a plan gets the same refusal.
         */
        const forged: JourneyDriftPlan = {
            ...drift,
            drifted: drift.drifted.map((report) => ({ ...report, repairable: true })),
        };

        const refused = await repair(scenario, journey, forged, ['hangout-channel']);
        expect(refused.results).toEqual([expect.objectContaining({ outcome: 'refused' })]);

        expect(lounge.name).toBe('chill-zone');
        expect(scenario.discord.writesTo(lounge)).toEqual([]);
    });

    it('6. one rejected write fails that repair only; the other channel is still fixed', async () => {
        const scenario = await startScenario();
        const roomsJourney = (rulesName: string): JourneyDeclaration => ({
            journeyKey: 'rooms',
            name: 'Rooms',
            resources: [
                { key: 'rules-channel', kind: 'textChannel', defaultName: rulesName },
                { key: 'intros-channel', kind: 'textChannel', defaultName: 'intros' },
            ],
        });
        const result = await install(scenario, roomsJourney('rules'));
        const rules = installedChannel(scenario, result, 'rules-channel');
        const intros = installedChannel(scenario, result, 'intros-channel');

        /*
         * `rules` drifts by a *panel* rename, so the declared name differs from the one the
         * binding recorded. That is what lets the binding assertion below fail: a repair
         * that synced the row despite Discord refusing the rename would write "rules-v2",
         * where a Discord-side rename would have written back the same "rules" either way.
         */
        const journey = roomsJourney('rules-v2');
        intros.rename('intro-dump');
        rules.rejectWrites({ code: RESTJSONErrorCodes.MissingPermissions });

        const drift = await checkDrift(scenario, journey);
        expect(drift.drifted).toHaveLength(2);

        const repaired = await repair(scenario, journey, drift, ['rules-channel', 'intros-channel']);
        expect(repaired.refusal).toBeUndefined();

        const outcomeByKey = new Map(repaired.results.map((entry) => [entry.resourceKey, entry] as const));
        expect(outcomeByKey.get('intros-channel')).toMatchObject({ outcome: 'repaired', repaired: ['renamed'] });
        expect(outcomeByKey.get('rules-channel')).toMatchObject({
            outcome: 'failed',
            explanation: expect.stringMatching(/Missing Permissions/),
        });
        expect(outcomeByKey.get('rules-channel')?.repaired).toBeUndefined();

        expect(rules.name).toBe('rules');
        expect(intros.name).toBe('intros');
        expect(await bindingFor(scenario, 'rooms', 'rules-channel')).toMatchObject({ name: 'rules' });

        const recheck = await checkDrift(scenario, journey);
        expect(recheck.drifted.map((report) => report.resourceKey)).toEqual(['rules-channel']);
    });

    it('7. a permission repair edits the drifted overwrite and keeps a hand-added one', async () => {
        const scenario = await startScenario();
        const { discord, guild, staff } = scenario;
        const journey = lobbyJourney();
        const result = await install(scenario, journey);
        const welcome = installedChannel(scenario, result, WELCOME_KEY);
        const bystander = guild.createMember({ username: 'bystander' });

        /*
         * The staff overwrite is *weakened*, not removed, and carries a bit the declaration
         * never mentions. Removing it would make an edit and a replace send the identical
         * PUT; with `AttachFiles` present, only an edit keeps it.
         */
        welcome.setOverwrite(staff, { allow: ['ViewChannel', 'AttachFiles'], deny: ['SendMessages'] });
        welcome.setOverwrite(bystander, { allow: ['ViewChannel', 'SendMessages'] });

        const drift = await checkDrift(scenario, journey);
        expect(drift.drifted).toHaveLength(1);
        expect(drift.drifted[0]).toMatchObject({ resourceKey: WELCOME_KEY });
        const permissionDrift = drift.drifted[0]?.drift.find((entry) => entry.kind === 'permissions');
        if (permissionDrift?.kind !== 'permissions') throw new Error('Expected permission drift.');
        expect(permissionDrift.differences).toHaveLength(1);
        expect(permissionDrift.differences[0]?.id).toBe(staff.id);
        expect([...(permissionDrift.differences[0]?.missingAllow ?? [])].sort()).toEqual(
            [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.AddReactions]
                .map(String)
                .sort()
        );
        expect(permissionDrift.differences[0]?.missingDeny).toEqual([]);

        const writesBeforeRepair = discord.writesTo(welcome).length;
        const repaired = await repair(scenario, journey, drift, [WELCOME_KEY]);
        expect(repaired.results).toEqual([expect.objectContaining({ outcome: 'repaired', repaired: ['permissions'] })]);

        expect(welcome.overwriteFor(staff)).toEqual({
            id: staff.id,
            type: 'role',
            allow: ['AddReactions', 'AttachFiles', 'SendMessages', 'SendMessagesInThreads', 'ViewChannel'],
            deny: [],
        });
        expect(welcome.overwriteFor(bystander)).toEqual({
            id: bystander.id,
            type: 'member',
            allow: ['SendMessages', 'ViewChannel'],
            deny: [],
        });
        expect(welcome.overwriteFor(guild.everyone)).toEqual({
            id: guild.everyone.id,
            type: 'role',
            allow: ['ViewChannel'],
            deny: POSTING,
        });

        // On the wire: one per-id PUT for the drifted overwrite, and no whole-set replace.
        const repairWrites = discord.writesTo(welcome).slice(writesBeforeRepair);
        expect(repairWrites.map((request) => `${request.method} ${request.path}`)).toEqual([
            `PUT /channels/${welcome.id}/permissions/${staff.id}`,
        ]);

        discord.flushGateway();
        expect((await checkDrift(scenario, journey)).drifted).toEqual([]);
    });

    it('8. a repair that fails partway reports what landed, and the binding records the rename that did', async () => {
        const scenario = await startScenario();
        const { staff } = scenario;
        const result = await install(scenario, lobbyJourney());
        const welcome = installedChannel(scenario, result, WELCOME_KEY);
        const renamed = lobbyJourney('welcome-mat');

        // A panel rename that Discord will accept, and a permission fix it will refuse.
        welcome.removeOverwrite(staff);
        welcome.rejectWrites({
            code: RESTJSONErrorCodes.MissingPermissions,
            route: 'PUT /channels/:channelId/permissions/:overwriteId',
        });

        const drift = await checkDrift(scenario, renamed);
        expect(drift.drifted[0]?.drift.map((entry) => entry.kind)).toEqual(['renamed', 'permissions']);

        const repaired = await repair(scenario, renamed, drift, [WELCOME_KEY]);
        expect(repaired.results).toEqual([
            expect.objectContaining({
                resourceKey: WELCOME_KEY,
                outcome: 'failed',
                repaired: ['renamed'],
                explanation: expect.stringMatching(/Missing Permissions/),
            }),
        ]);

        expect(welcome.name).toBe('welcome-mat');
        expect(welcome.overwriteFor(staff)).toBeUndefined();

        // Only the refused half is still drift.
        const recheck = await checkDrift(scenario, renamed);
        expect(recheck.drifted[0]?.drift.map((entry) => entry.kind)).toEqual(['permissions']);

        /*
         * The rename landed on Discord, so the row every later report names this resource
         * by must say so. `renameBinding`'s own contract is that a name disagreeing with
         * the guild "makes a report an operator cannot match up to what they are looking at".
         * Both are soft so a failure shows the operator-visible label and its root cause.
         */
        expect.soft(recheck.drifted[0]?.name).toBe('welcome-mat');
        expect.soft(await bindingFor(scenario, LOBBY, WELCOME_KEY)).toMatchObject({ name: 'welcome-mat' });
    });

    it('9. a permission naming a role the journey creates installs, checks clean, and repairs', async () => {
        const scenario = await startScenario();
        const { discord, guild } = scenario;
        const journey: JourneyDeclaration = {
            journeyKey: 'approvals',
            name: 'Approvals',
            resources: [
                { key: 'approved-role', kind: 'role', defaultName: 'Approved' },
                {
                    key: 'approved-lounge',
                    kind: 'textChannel',
                    defaultName: 'approved-lounge',
                    permissions: [
                        { audience: 'everyone', access: 'hidden' },
                        { audience: 'roles', roleIds: [declaredRoleReference('approved-role')], access: 'readWrite' },
                    ],
                },
            ],
        };

        const result = await install(scenario, journey);
        expect(result.applied.map((entry) => [entry.resourceKey, entry.action])).toEqual([
            ['approved-role', 'created'],
            ['approved-lounge', 'created'],
        ]);

        const roleBinding = result.applied.find((entry) => entry.resourceKey === 'approved-role');
        if (!roleBinding) throw new Error('The install bound no role.');
        const approved = guild.role(roleBinding.discordId);
        const lounge = installedChannel(scenario, result, 'approved-lounge');

        expectOverwrites(lounge, [
            { id: guild.everyone.id, type: 'role', allow: [], deny: ['ViewChannel'] },
            { id: approved.id, type: 'role', allow: READ_WRITE, deny: [] },
            { id: guild.bot.id, type: 'member', allow: READ_WRITE, deny: [] },
        ]);

        // Install resolved the reference from the ids it had just created; drift resolves it
        // from the bindings. If the two disagreed the lounge would land in `unchecked`.
        const clean = await checkDrift(scenario, journey);
        expect(clean.drifted).toEqual([]);
        expect(clean.unchecked).toEqual([]);
        expect([...clean.cleanKeys].sort()).toEqual(['approved-lounge', 'approved-role']);

        lounge.removeOverwrite(approved);

        const drift = await checkDrift(scenario, journey);
        expect(drift.unchecked).toEqual([]);
        expect(drift.drifted).toEqual([
            expect.objectContaining({
                resourceKey: 'approved-lounge',
                drift: [{ kind: 'permissions', differences: [expect.objectContaining({ id: approved.id })] }],
            }),
        ]);

        const repaired = await repair(scenario, journey, drift, ['approved-lounge']);
        expect(repaired.results).toEqual([expect.objectContaining({ outcome: 'repaired', repaired: ['permissions'] })]);
        expect(lounge.overwriteFor(approved)).toEqual({ id: approved.id, type: 'role', allow: READ_WRITE, deny: [] });

        discord.flushGateway();
        expect((await checkDrift(scenario, journey)).drifted).toEqual([]);
    });

    /*
     * Discord stores a text channel's name lowercased with spaces as hyphens. A
     * declaration of `Welcome Mat` used to be sent as written, and live it produced a
     * rename drift on a clean install that no repair could clear. TestDiscord stores the
     * rewritten name as Discord does, so the old behaviour fails here on the binding's
     * name (install) and on the clean drift check (drift) — each sabotage-verified.
     */
    it('10. a text channel declared with capitals and spaces installs under the name Discord stores, and checks clean', async () => {
        const scenario = await startScenario();
        const journey = lobbyJourney('Welcome Mat');

        const result = await install(scenario, journey);
        const welcome = installedChannel(scenario, result, WELCOME_KEY);

        expect(welcome.name).toBe('welcome-mat');
        expect(await bindingFor(scenario, LOBBY, WELCOME_KEY)).toMatchObject({ name: 'welcome-mat' });
        // Categories keep their case in Discord, so the category is untouched.
        expect(installedChannel(scenario, result, CATEGORY_KEY).name).toBe('Lobby');

        expect((await checkDrift(scenario, journey)).drifted).toEqual([]);
    });

    it('11. a declared name matches an existing channel by the name Discord stores, instead of creating a duplicate', async () => {
        const scenario = await startScenario();
        const existing = scenario.guild.createTextChannel({ name: 'staff-chat' });
        scenario.discord.flushGateway();

        const plan = await withinDeadlockTimeout(
            previewInstall({
                guild: scenario.liveGuild,
                journey: lobbyJourney('Staff Chat'),
                staffRoleIds: [scenario.staff.id],
            }),
            'previewInstall'
        );

        // Blocked with the match named, which is the plan's way of asking whether to
        // adopt it — the outcome a lowercase-only comparison missed, planning a create.
        expect(plan.items.find((item) => item.resourceKey === WELCOME_KEY)).toMatchObject({
            action: 'blocked',
            discordId: existing.id,
            name: 'staff-chat',
        });
    });
});
