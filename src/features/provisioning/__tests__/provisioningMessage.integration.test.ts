import { createHash, randomBytes } from 'node:crypto';
import { ButtonStyle, ComponentType, RESTJSONErrorCodes, type Guild, type PermissionsString } from 'discord.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    TestDiscord,
    type RecordedRequest,
    type ServerChannel,
    type ServerGuild,
} from '../../../shared/__tests__/support/testDiscord';
import type { ButtonListener, ButtonListenerReader } from '../buttonListeners';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import type { ApplyDriftRepairResult } from '../logic/applyDriftRepair';
import type { ApplyInstallPlanResult } from '../logic/applyInstallPlan';
import type { InstallPlan, PlanItem } from '../logic/installPlan';
import type { JourneyDriftPlan } from '../logic/journeyDriftPlan';
import type { MessageButton } from '../logic/messageButtons';
import type { JourneyDeclaration, ResourceDeclaration } from '../logic/resourceDeclaration';
import { createProvisioningTestDb, withinDeadlockTimeout } from './support/provisioningTestDb';

/**
 * A journey's message resource, end to end: install posts it, a second install leaves it,
 * a deleted one is posted again, uninstall deletes it — against real discord.js, a real
 * `resource_bindings` table and real `guild_uploads`, in the style of
 * `provisioningDrift.integration.test.ts`.
 *
 * Every scenario drives the service functions the web routes call (`previewInstall`,
 * `installJourney`, `previewDrift`, `repairDrift`, `previewUnpublish`, `unpublishJourney`),
 * and asserts on what TestDiscord holds — the server — rather than on the client's cache.
 *
 * Fixtures carry no raw `<@id>`: TestDiscord faults on an edit that touches a mention, and a
 * resource message pings nobody anyway.
 */

const testDb = await createProvisioningTestDb();

vi.mock('../../../features-system/data-persistence/database', () => ({
    get database() {
        return testDb.db;
    },
}));

/**
 * The real `prepareMessageEdit`, unless a test sets `fault`: then it throws that, as a bug
 * past every refusal it knows about would.
 */
const prepareMessageEditFault = vi.hoisted(() => ({ fault: undefined as Error | undefined }));
vi.mock('../logic/prepareMessageEdit', async (importOriginal) => {
    const original = await importOriginal<typeof import('../logic/prepareMessageEdit')>();
    return {
        ...original,
        prepareMessageEdit: (...args: Parameters<typeof original.prepareMessageEdit>) => {
            if (prepareMessageEditFault.fault) return Promise.reject(prepareMessageEditFault.fault);
            return original.prepareMessageEdit(...args);
        },
    };
});

const { installJourney, previewDrift, previewInstall, previewUnpublish, repairDrift, unpublishJourney } = await import(
    '../provisioningService'
);
const { clearButtonListenerReaderForTests, registerButtonListenerReader } = await import('../buttonListeners');
const { describeDrift } = await import('../logic/resourceDrift');
const { resourceBindingsRepo } = await import('../data/resourceBindingsRepo');
const { journeysRepo } = await import('../data/journeysRepo');
const { guildUploadsRepo } = await import('../../../features-system/guild-uploads');
const { messageDigest } = await import('../logic/messageDrift');

const BOT_PERMISSIONS: readonly PermissionsString[] = [
    'ManageChannels',
    'ManageRoles',
    'SendMessages',
    'EmbedLinks',
    'ReadMessageHistory',
    'AttachFiles',
];

const JOURNEY_KEY = 'house';
const RULES_KEY = 'rules';
const LOUNGE_KEY = 'lounge';
const PANEL_KEY = 'rules-panel';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Seven buttons, so they lay out as a row of five and a row of two. */
const BUTTONS: readonly MessageButton[] = [
    { key: 'agree', label: 'I agree', style: 'Success' },
    { key: 'disagree', label: 'Nope', style: 'Danger' },
    { key: 'kinks', label: 'Kinks', style: 'Primary' },
    { key: 'limits', label: 'Limits', style: 'Secondary' },
    { key: 'aftercare', label: 'Aftercare', style: 'Primary' },
    { key: 'safeword', label: 'Safeword', style: 'Danger' },
    { key: 'staff', label: 'Ask staff', style: 'Secondary' },
];

interface Scenario {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly liveGuild: Guild;
    readonly thumbnailId: string;
    readonly thumbnailBytes: Buffer;
}

/** Two channels, and a message in the first: plain text, two embeds, an uploaded thumbnail, seven buttons. */
function houseJourney(scenario: Scenario, panel: Partial<ResourceDeclaration> = {}): JourneyDeclaration {
    return {
        journeyKey: JOURNEY_KEY,
        name: 'House',
        resources: [
            { key: RULES_KEY, kind: 'textChannel', defaultName: 'rules' },
            { key: LOUNGE_KEY, kind: 'textChannel', defaultName: 'lounge' },
            {
                key: PANEL_KEY,
                kind: 'message',
                defaultName: 'Rules panel',
                parentKey: RULES_KEY,
                message: {
                    content: 'Read these, then pick.',
                    embeds: [
                        { title: 'House rules', description: 'Consent, always.', thumbnail: `upload:${scenario.thumbnailId}` },
                        { title: 'Safewords', fields: [{ name: 'Red', value: 'Stop.' }] },
                    ],
                },
                buttons: BUTTONS,
                ...panel,
            },
        ],
    };
}

const running: TestDiscord[] = [];

/**
 * Who listens to the house journey's buttons, as flows' reader would answer — nobody unless a
 * test says. A stand-in rather than the real reader, which needs the block registry and the
 * flows tables: what is under test here is what provisioning does with the answer.
 */
let listeners: ButtonListener[] = [];
const standInReader: ButtonListenerReader = (_guildId, journeyKey) =>
    Promise.resolve(journeyKey === JOURNEY_KEY ? listeners : []);
registerButtonListenerReader(standInReader);

/** A trigger of flow `flowName` listening to `buttonKey` of the panel. */
function listening(flowName: string, buttonKey: string): ButtonListener {
    return { messageKey: PANEL_KEY, buttonKey, flowId: `flow-${flowName}`, flowName, nodeId: 'trigger', enabled: true };
}

beforeEach(async () => {
    listeners = [];
    await testDb.db.deleteFrom('resource_bindings').execute();
    await testDb.db.deleteFrom('journeys').execute();
});

afterEach(async () => {
    prepareMessageEditFault.fault = undefined;
    vi.restoreAllMocks();
    for (const discord of running.splice(0)) await discord.destroy();
});

afterAll(async () => {
    await testDb.db.destroy();
});

async function startScenario(): Promise<Scenario> {
    const discord = new TestDiscord();
    running.push(discord);

    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    await discord.start();

    const thumbnail = await storeUpload(guild.id, 'collar.png');
    return { discord, guild, liveGuild: discord.clientGuild(guild), thumbnailId: thumbnail.uploadId, thumbnailBytes: thumbnail.bytes };
}

/** A PNG uploaded to this guild, as the dashboard stores one. */
async function storeUpload(guildId: string, fileName: string): Promise<{ readonly uploadId: string; readonly bytes: Buffer }> {
    const bytes = Buffer.concat([PNG_SIGNATURE, randomBytes(256)]);
    const { upload } = await guildUploadsRepo.create({
        guildId,
        fileName,
        contentType: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        uploadedBy: 'operator-1',
    });
    return { uploadId: upload.uploadId, bytes };
}

async function plan(scenario: Scenario, journey: JourneyDeclaration): Promise<InstallPlan> {
    return withinDeadlockTimeout(previewInstall({ guild: scenario.liveGuild, journey, staffRoleIds: [] }), 'previewInstall');
}

/** Preview then apply, as `runInstall` does, and insist the install was clean. */
async function install(scenario: Scenario, journey: JourneyDeclaration): Promise<ApplyInstallPlanResult> {
    const approvedPlan = await plan(scenario, journey);
    expect(approvedPlan.blockers).toEqual([]);
    expect(approvedPlan.items.filter((item) => item.action === 'blocked')).toEqual([]);

    const result = await withinDeadlockTimeout(
        installJourney({ guild: scenario.liveGuild, journey, staffRoleIds: [], approvedPlan }),
        'installJourney'
    );
    expect(result.failure).toBeUndefined();
    return result;
}

function itemFor(installPlan: InstallPlan, resourceKey: string): PlanItem {
    const item = installPlan.items.find((candidate) => candidate.resourceKey === resourceKey);
    if (!item) throw new Error(`The plan has no item for "${resourceKey}".`);
    return item;
}

function appliedId(result: ApplyInstallPlanResult, resourceKey: string): string {
    const applied = result.applied.find((entry) => entry.resourceKey === resourceKey);
    if (!applied) throw new Error(`The install bound nothing to "${resourceKey}".`);
    return applied.discordId;
}

async function panelRow(scenario: Scenario): Promise<ResourceBindingEntity | null> {
    return withinDeadlockTimeout(resourceBindingsRepo.get(scenario.guild.id, JOURNEY_KEY, PANEL_KEY), 'resourceBindingsRepo.get');
}

/** Every message the bot posted, as it crossed the wire. */
function messagePosts(scenario: Scenario): readonly RecordedRequest[] {
    return scenario.discord.requests.filter((request) => request.method === 'POST' && /^\/channels\/\d+\/messages$/.test(request.path));
}

/** Install the house journey and hand back the channel the panel is posted in, and the panel's id. */
async function installHouse(scenario: Scenario): Promise<{ readonly rules: ServerChannel; readonly messageId: string }> {
    const result = await install(scenario, houseJourney(scenario));
    return { rules: scenario.guild.channel(appliedId(result, RULES_KEY)), messageId: appliedId(result, PANEL_KEY) };
}

describe('installing a message resource', () => {
    it('posts it once, in its channel, as one send: text, two embeds, the uploaded thumbnail and seven buttons in rows of five and two', async () => {
        const scenario = await startScenario();

        const { rules, messageId } = await installHouse(scenario);

        const posts = messagePosts(scenario);
        expect(posts).toHaveLength(1);
        expect(posts[0]?.path).toBe(`/channels/${rules.id}/messages`);
        expect(posts[0]?.files).toEqual([
            { index: 0, name: `${scenario.thumbnailId}.png`, contentType: 'image/png', bytes: scenario.thumbnailBytes },
        ]);
        expect(posts[0]?.body).toMatchObject({ allowed_mentions: { parse: [] }, attachments: [{ id: '0' }] });

        const posted = rules.message(messageId);
        expect(posted.content).toBe('Read these, then pick.');
        expect(posted.embeds.map((embed) => embed.title)).toEqual(['House rules', 'Safewords']);
        expect(posted.embeds[0]?.thumbnail?.url).toBe(`attachment://${scenario.thumbnailId}.png`);
        expect(posted.attachments).toEqual([
            { filename: `${scenario.thumbnailId}.png`, size: scenario.thumbnailBytes.length, contentType: 'image/png' },
        ]);
        expect(posted.components.map((row) => row.components.length)).toEqual([5, 2]);
        expect(posted.components.flatMap((row) => row.components)).toEqual(
            BUTTONS.map((button) =>
                expect.objectContaining({
                    type: ComponentType.Button,
                    custom_id: `mbtn:${button.key}`,
                    label: button.label,
                    style: ButtonStyle[button.style],
                })
            )
        );
    });

    it('records the message id, its channel and the fingerprint of what was posted', async () => {
        const scenario = await startScenario();
        const journey = houseJourney(scenario);

        const result = await install(scenario, journey);

        const panel = journey.resources.find((resource) => resource.key === PANEL_KEY);
        expect(await panelRow(scenario)).toMatchObject({
            kind: 'message',
            state: 'created',
            discordId: appliedId(result, PANEL_KEY),
            messageChannelId: appliedId(result, RULES_KEY),
            messageDigest: messageDigest(panel!.message!, panel!.buttons),
            name: 'Rules panel',
        });
    });

    it('notes, by label, only the buttons no flow listens to', async () => {
        const scenario = await startScenario();
        listeners = BUTTONS.filter((button) => button.key !== 'kinks' && button.key !== 'staff').map((button) =>
            listening('Welcome', button.key)
        );

        const installPlan = await plan(scenario, houseJourney(scenario));

        expect(itemFor(installPlan, PANEL_KEY).note).toBe(
            'Nobody listens to "Kinks" or "Ask staff" yet — a press answers "Nothing\'s hooked up to this yet".'
        );
    });

    it('refuses to plan a message with buttons when no boot root registered who listens to them', async () => {
        const scenario = await startScenario();
        clearButtonListenerReaderForTests();
        try {
            await expect(plan(scenario, houseJourney(scenario))).rejects.toThrow(/no button listener reader is registered/);
        } finally {
            registerButtonListenerReader(standInReader);
        }
    });

    it('reuses it on a second install, and sends nothing', async () => {
        const scenario = await startScenario();
        const { messageId } = await installHouse(scenario);

        const again = await plan(scenario, houseJourney(scenario));
        expect(itemFor(again, PANEL_KEY)).toMatchObject({ action: 'reuse', discordId: messageId });

        await install(scenario, houseJourney(scenario));
        expect(messagePosts(scenario)).toHaveLength(1);
    });

    it('posts it again when somebody deleted it, saying so, and records the new one', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);

        rules.deleteMessage(messageId);

        const again = await plan(scenario, houseJourney(scenario));
        expect(itemFor(again, PANEL_KEY)).toMatchObject({
            action: 'create',
            reason: 'The message this journey posted no longer exists, so it will be posted again.',
        });

        const result = await install(scenario, houseJourney(scenario));
        const reposted = appliedId(result, PANEL_KEY);
        expect(reposted).not.toBe(messageId);
        expect(rules.messages.map((message) => message.id)).toEqual([reposted]);
        expect((await panelRow(scenario))?.discordId).toBe(reposted);
    });

    it('blocks rather than reposting when the journey now puts the message in another channel', async () => {
        const scenario = await startScenario();
        await installHouse(scenario);

        const moved = await plan(scenario, houseJourney(scenario, { parentKey: LOUNGE_KEY }));

        expect(itemFor(moved, PANEL_KEY)).toMatchObject({
            action: 'blocked',
            reason: "It's posted in #rules, but this journey now puts it in another channel. Discord can't move a message: delete it there and install again.",
        });
    });

    it('blocks the item, naming the channel, when the bot can no longer read it — not a 500', async () => {
        const scenario = await startScenario();
        const { rules } = await installHouse(scenario);

        rules.refuseHistory();

        const refused = await plan(scenario, houseJourney(scenario));
        expect(itemFor(refused, PANEL_KEY)).toMatchObject({ action: 'blocked' });
        expect(itemFor(refused, PANEL_KEY).reason).toMatch(/^Couldn't check it in #rules: the bot can't even see it \(Missing Access\)/);
    });

    it('blocks without asking Discord when the channel denies the bot Read Message History — never reads it as gone', async () => {
        const scenario = await startScenario();
        const { rules } = await installHouse(scenario);
        rules.setOverwrite(scenario.guild.bot, { allow: ['ViewChannel', 'SendMessages'], deny: ['ReadMessageHistory'] });
        const before = scenario.discord.requests.length;

        const shut = await plan(scenario, houseJourney(scenario));

        expect(itemFor(shut, PANEL_KEY)).toMatchObject({
            action: 'blocked',
            reason: "Couldn't check it in #rules: the bot lacks **Read Message History** there.",
        });
        expect(scenario.discord.requests.slice(before).filter((request) => request.path.includes('/messages/'))).toEqual([]);
    });

    it('blocks a repost into a channel it holds whose own overwrites deny the bot what posting needs', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);
        rules.deleteMessage(messageId);
        rules.setOverwrite(scenario.guild.bot, { allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], deny: ['EmbedLinks', 'AttachFiles'] });

        const shut = await plan(scenario, houseJourney(scenario));

        expect(itemFor(shut, PANEL_KEY)).toMatchObject({
            action: 'blocked',
            reason: "The bot lacks **Embed Links** and **Attach Files** in #rules, which posting it there needs. Fix that channel's permissions, then install again.",
        });
    });
});

describe('uninstalling a message resource', () => {
    async function uninstall(scenario: Scenario, journeyKey = JOURNEY_KEY) {
        const teardown = await withinDeadlockTimeout(previewUnpublish(scenario.liveGuild, journeyKey), 'previewUnpublish');
        return { teardown, apply: () => withinDeadlockTimeout(unpublishJourney({ guild: scenario.liveGuild, approvedPlan: teardown }), 'unpublishJourney') };
    }

    /** Every delete the bot sent, in order, as `kind:id`. */
    function deletes(scenario: Scenario): readonly string[] {
        return scenario.discord.requests
            .filter((request) => request.method === 'DELETE')
            .map((request) => (request.path.includes('/messages/') ? `message:${request.path.split('/').at(-1)}` : `channel:${request.path.split('/').at(-1)}`));
    }

    it('deletes the message before the channel it is posted in', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);

        const { teardown, apply } = await uninstall(scenario);
        expect(teardown.items.find((item) => item.resourceKey === PANEL_KEY)).toMatchObject({ action: 'delete', discordId: messageId });
        const result = await apply();

        expect(result.results.find((entry) => entry.resourceKey === PANEL_KEY)).toMatchObject({ outcome: 'deleted' });
        const order = deletes(scenario);
        expect(order.indexOf(`message:${messageId}`)).toBeGreaterThan(-1);
        expect(order.indexOf(`message:${messageId}`)).toBeLessThan(order.indexOf(`channel:${rules.id}`));
        expect(rules.exists).toBe(false);
        expect(await panelRow(scenario)).toBeNull();
    });

    it('counts a message deleted by hand between the plan and the confirm as done, and drops its row', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);

        const { apply } = await uninstall(scenario);
        rules.deleteMessage(messageId);
        const result = await apply();

        expect(result.results.find((entry) => entry.resourceKey === PANEL_KEY)?.outcome).not.toBe('failed');
        expect(result.results.every((entry) => entry.outcome !== 'failed')).toBe(true);
        expect(await panelRow(scenario)).toBeNull();
        expect(rules.exists).toBe(false);
    });

    it('keeps the record of a message an install posted again between the teardown plan and its apply, and says it was not uninstalled', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);

        // The routes plan before they take the journey lock; an install holding it meanwhile
        // reposts onto the same row.
        const { apply } = await uninstall(scenario);
        rules.deleteMessage(messageId);
        const reinstall = await install(scenario, houseJourney(scenario));
        const reposted = appliedId(reinstall, PANEL_KEY);
        const result = await apply();

        // Not `forgotten`: the record stays, naming the new post, so the dialog must not call
        // this message uninstalled.
        expect(result.results.find((entry) => entry.resourceKey === PANEL_KEY)).toMatchObject({
            outcome: 'refused',
            explanation: expect.stringContaining('posted again meanwhile'),
        });
        expect((await panelRow(scenario))?.discordId).toBe(reposted);
    });

    it('still deletes the message when the journey row it came from is gone', async () => {
        const scenario = await startScenario();
        const journey = houseJourney(scenario);
        await journeysRepo.create({ guildId: scenario.guild.id, journeyKey: JOURNEY_KEY, name: journey.name, resources: journey.resources });
        const result = await install(scenario, journey);
        const rules = scenario.guild.channel(appliedId(result, RULES_KEY));

        await journeysRepo.deleteByKey(scenario.guild.id, JOURNEY_KEY);
        const { apply } = await uninstall(scenario);
        await apply();

        expect(deletes(scenario)).toContain(`message:${appliedId(result, PANEL_KEY)}`);
        expect(rules.exists).toBe(false);
        expect(await panelRow(scenario)).toBeNull();
    });

    it('forgets a message already gone, and refuses one it could not read', async () => {
        const gone = await startScenario();
        const posted = await installHouse(gone);
        posted.rules.deleteMessage(posted.messageId);
        expect((await uninstall(gone)).teardown.items.find((item) => item.resourceKey === PANEL_KEY)).toMatchObject({ action: 'forget' });

        const unreadable = await startScenario();
        const { rules } = await installHouse(unreadable);
        rules.refuseHistory();
        expect((await uninstall(unreadable)).teardown.items.find((item) => item.resourceKey === PANEL_KEY)).toMatchObject({
            action: 'refuse',
            refusalReason: 'unreadable',
        });
    });

    it('reports a delete Discord refuses as failed, and keeps the record of the message still posted', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);

        const { teardown, apply } = await uninstall(scenario);
        expect(teardown.items.find((item) => item.resourceKey === PANEL_KEY)).toMatchObject({ action: 'delete' });
        // The bot lost access between the plan and the confirm: Discord answers the DELETE 50001.
        rules.rejectWrites({ code: RESTJSONErrorCodes.MissingAccess });
        const result = await apply();

        expect(result.results.find((entry) => entry.resourceKey === PANEL_KEY)).toMatchObject({
            outcome: 'failed',
            explanation: expect.stringMatching(/^Discord would not allow it — check the bot can still see #rules: /),
        });
        expect(rules.message(messageId).id).toBe(messageId);
        expect((await panelRow(scenario))?.discordId).toBe(messageId);
    });
});

describe('a message in a channel a Community server made an announcement channel', () => {
    it('is still found, repaired in place, and deleted on uninstall — never unreadable', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);
        rules.convertToAnnouncement();
        scenario.discord.flushGateway();

        const changed = houseJourney(scenario, {
            message: { content: 'Read these, then pick.', embeds: [{ title: 'House rules, announced' }] },
        });
        const drift = await check(scenario, changed);
        expect(drift.unchecked.map((entry) => entry.resourceKey)).not.toContain(PANEL_KEY);
        expect(drift.drifted.find((report) => report.resourceKey === PANEL_KEY)?.drift).toEqual([
            { kind: 'outOfDate', declarationMoved: true, embedsHidden: false },
        ]);

        const repaired = await repair(scenario, changed, drift);
        expect(repaired.results.find((entry) => entry.resourceKey === PANEL_KEY)).toMatchObject({ outcome: 'repaired' });
        expect(rules.message(messageId).embeds.map((embed) => embed.title)).toEqual(['House rules, announced']);

        const teardown = await withinDeadlockTimeout(previewUnpublish(scenario.liveGuild, JOURNEY_KEY), 'previewUnpublish');
        expect(teardown.items.find((item) => item.resourceKey === PANEL_KEY)).toMatchObject({ action: 'delete', discordId: messageId });
        const result = await withinDeadlockTimeout(unpublishJourney({ guild: scenario.liveGuild, approvedPlan: teardown }), 'unpublishJourney');
        expect(result.results.find((entry) => entry.resourceKey === PANEL_KEY)).toMatchObject({ outcome: 'deleted' });
        expect(rules.messages.map((message) => message.id)).not.toContain(messageId);
    });
});

/** The drift check the dashboard runs, for this journey as declared now. */
async function check(scenario: Scenario, journey: JourneyDeclaration): Promise<JourneyDriftPlan> {
    return withinDeadlockTimeout(previewDrift({ guild: scenario.liveGuild, journey, staffRoleIds: [] }), 'previewDrift');
}

/** Repair what `plan` found, ticking `keys`, as the route does after rebuilding the plan. */
async function repair(
    scenario: Scenario,
    journey: JourneyDeclaration,
    plan: JourneyDriftPlan,
    keys: readonly string[] = [PANEL_KEY]
): Promise<ApplyDriftRepairResult> {
    return withinDeadlockTimeout(
        repairDrift({ guild: scenario.liveGuild, journey, staffRoleIds: [], approvedPlan: plan, approvedKeys: new Set(keys) }),
        'repairDrift'
    );
}

/** Every edit of a message the bot sent, as it crossed the wire. */
function messageEdits(scenario: Scenario): readonly RecordedRequest[] {
    return scenario.discord.requests.filter((request) => request.method === 'PATCH' && /^\/channels\/\d+\/messages\/\d+$/.test(request.path));
}

describe('drift and repair of a message resource', () => {
    it('reads a fresh install as clean', async () => {
        const scenario = await startScenario();
        await installHouse(scenario);

        const drift = await check(scenario, houseJourney(scenario));

        expect(drift.drifted).toEqual([]);
        expect(drift.unchecked).toEqual([]);
        expect(drift.cleanKeys).toContain(PANEL_KEY);
    });

    it('reports a changed declaration as out of date, and repair edits the same message in place: new title and picture, no text, no buttons', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);
        const banner = await storeUpload(scenario.guild.id, 'banner.png');

        // The title changes, the thumbnail gives way to a new picture, and the text and
        // every button go.
        const changed = houseJourney(scenario, {
            message: { embeds: [{ title: 'House rules, revised', image: `upload:${banner.uploadId}` }] },
            buttons: [],
        });
        const drift = await check(scenario, changed);
        expect(drift.drifted).toEqual([
            expect.objectContaining({
                resourceKey: PANEL_KEY,
                kind: 'message',
                name: 'Rules panel',
                discordId: messageId,
                drift: [{ kind: 'outOfDate', declarationMoved: true, embedsHidden: false }],
                repairable: true,
            }),
        ]);
        expect(drift.cleanKeys).not.toContain(PANEL_KEY);

        const result = await repair(scenario, changed, drift);

        expect(result.refusal).toBeUndefined();
        expect(result.results).toEqual([
            { resourceKey: PANEL_KEY, kind: 'message', name: 'Rules panel', outcome: 'repaired', repaired: ['outOfDate'] },
        ]);
        // One edit of the same message, and no new post.
        expect(messagePosts(scenario)).toHaveLength(1);
        const edits = messageEdits(scenario);
        expect(edits.map((request) => request.path)).toEqual([`/channels/${rules.id}/messages/${messageId}`]);
        expect(edits[0]?.body).toMatchObject({
            content: '',
            components: [],
            attachments: [{ id: '0' }],
            allowed_mentions: { parse: [] },
            flags: 0,
        });
        expect(edits[0]?.files).toEqual([
            { index: 0, name: `${banner.uploadId}.png`, contentType: 'image/png', bytes: banner.bytes },
        ]);

        // What Discord holds now: the same message, saying what the journey says.
        expect(rules.messages.map((message) => message.id)).toEqual([messageId]);
        const held = rules.message(messageId);
        expect(held.content).toBe('');
        expect(held.embeds.map((embed) => embed.title)).toEqual(['House rules, revised']);
        expect(held.embeds[0]?.image?.url).toBe(`attachment://${banner.uploadId}.png`);
        expect(held.attachments).toEqual([{ filename: `${banner.uploadId}.png`, size: banner.bytes.length, contentType: 'image/png' }]);
        expect(held.components).toEqual([]);
        expect(held.edited).toBe(true);

        const panel = changed.resources.find((resource) => resource.key === PANEL_KEY);
        expect((await panelRow(scenario))?.messageDigest).toBe(messageDigest(panel!.message!, panel!.buttons));

        const after = await check(scenario, changed);
        expect(after.drifted).toEqual([]);
        expect(after.cleanKeys).toContain(PANEL_KEY);
    });

    it('names the flows whose button a repair would take away, and only those', async () => {
        const scenario = await startScenario();
        await installHouse(scenario);
        // `agree` stays declared; `safeword` and `staff` go, and a flow listens to each.
        listeners = [listening('Welcome', 'agree'), listening('Safety net', 'safeword'), listening('Concierge', 'staff')];

        const trimmed = houseJourney(scenario, {
            buttons: BUTTONS.filter((button) => button.key !== 'safeword' && button.key !== 'staff'),
        });
        const drift = await check(scenario, trimmed);

        const [report] = drift.drifted;
        expect(report?.drift).toEqual([
            {
                kind: 'outOfDate',
                declarationMoved: true,
                embedsHidden: false,
                disconnects: [
                    { flowName: 'Safety net', buttonLabel: 'Safeword' },
                    { flowName: 'Concierge', buttonLabel: 'Ask staff' },
                ],
            },
        ]);
        expect(describeDrift(report!.drift[0]!, 'message')).toBe(
            "What's posted is older than this journey's message. Repair edits it in place, so it keeps its spot in the channel. " +
                'Repairing it also takes away buttons flows listen to: **Safety net**\'s "Safeword" and **Concierge**\'s "Ask staff". ' +
                'Point those triggers at other buttons first, or they go deaf.'
        );
    });

    it('names one cut-off flow in a sentence of its own', async () => {
        const scenario = await startScenario();
        await installHouse(scenario);
        listeners = [listening('Safety net', 'safeword')];

        const trimmed = houseJourney(scenario, { buttons: BUTTONS.filter((button) => button.key !== 'safeword') });
        const [report] = (await check(scenario, trimmed)).drifted;

        expect(describeDrift(report!.drift[0]!, 'message')).toBe(
            "What's posted is older than this journey's message. Repair edits it in place, so it keeps its spot in the channel. " +
                'Repairing it also takes away the "Safeword" button **Safety net** listens to — point that trigger at another button first, or it goes deaf.'
        );
    });

    it('names nobody already cut off by an earlier repair when a later edit is repaired', async () => {
        const scenario = await startScenario();
        await installHouse(scenario);
        listeners = [listening('Safety net', 'safeword')];

        // An operator repaired the safeword button away despite the warning...
        const trimmed = houseJourney(scenario, { buttons: BUTTONS.filter((button) => button.key !== 'safeword') });
        const repaired = await repair(scenario, trimmed, await check(scenario, trimmed));
        expect(repaired.results.map((result) => result.outcome)).toEqual(['repaired']);

        // ...so the next edit takes nothing more away, and saying so again would be noise.
        const retitled = houseJourney(scenario, {
            message: { content: 'Read these, then pick. Now.', embeds: [] },
            buttons: BUTTONS.filter((button) => button.key !== 'safeword'),
        });
        const drift = await check(scenario, retitled);

        expect(drift.drifted[0]?.drift).toEqual([{ kind: 'outOfDate', declarationMoved: true, embedsHidden: false }]);
    });

    it('names nobody when the repair takes away no listened button', async () => {
        const scenario = await startScenario();
        await installHouse(scenario);
        listeners = [listening('Welcome', 'agree')];

        const retitled = houseJourney(scenario, { message: { content: 'Read these, then pick. Now.', embeds: [] } });
        const drift = await check(scenario, retitled);

        expect(drift.drifted[0]?.drift).toEqual([{ kind: 'outOfDate', declarationMoved: true, embedsHidden: false }]);
    });

    it('refuses a repair whose declaration Discord would now refuse, naming the part, and sends nothing', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);
        const before = (await panelRow(scenario))?.messageDigest;

        const broken = houseJourney(scenario, { message: { content: 'Read these.', embeds: [{}] } });
        const drift = await check(scenario, broken);
        expect(drift.drifted.map((report) => report.resourceKey)).toEqual([PANEL_KEY]);

        const result = await repair(scenario, broken, drift);

        expect(result.results).toEqual([
            expect.objectContaining({
                resourceKey: PANEL_KEY,
                outcome: 'refused',
                explanation: expect.stringMatching(/^"Rules panel" embed 1: Embed 1 is empty .* nothing was changed\.$/),
            }),
        ]);
        expect(messageEdits(scenario)).toEqual([]);
        expect(rules.message(messageId).edited).toBe(false);
        expect((await panelRow(scenario))?.messageDigest).toBe(before);
    });

    it('reports a message deleted between the check and the repair as failed, with install to post it again', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);
        const changed = houseJourney(scenario, {
            message: { content: 'Read these, then pick.', embeds: [{ title: 'House rules, revised' }] },
        });
        const drift = await check(scenario, changed);

        rules.deleteMessage(messageId);
        const result = await repair(scenario, changed, drift);

        expect(result.results).toEqual([
            expect.objectContaining({
                resourceKey: PANEL_KEY,
                outcome: 'failed',
                explanation: 'It was deleted since the check — install posts it again.',
            }),
        ]);
        expect(messagePosts(scenario)).toHaveLength(1);
    });

    it('leaves a message somebody deleted to install: neither clean nor drifted', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);
        rules.deleteMessage(messageId);

        const drift = await check(scenario, houseJourney(scenario));

        expect(drift.cleanKeys).not.toContain(PANEL_KEY);
        expect(drift.drifted).toEqual([]);
        expect(drift.unchecked).toEqual([]);
    });

    it('reports a message whose embeds a moderator hid as out of date, and repair shows them again', async () => {
        const scenario = await startScenario();
        const { rules, messageId } = await installHouse(scenario);
        const journey = houseJourney(scenario);

        // "Remove all embeds" in Discord: the declaration has not moved, so the fingerprint
        // still matches — only the read can see this.
        rules.suppressEmbeds(messageId);
        const drift = await check(scenario, journey);

        expect(drift.cleanKeys).not.toContain(PANEL_KEY);
        expect(drift.drifted).toEqual([
            expect.objectContaining({
                resourceKey: PANEL_KEY,
                drift: [{ kind: 'outOfDate', declarationMoved: false, embedsHidden: true }],
                repairable: true,
            }),
        ]);

        const result = await repair(scenario, journey, drift);

        expect(result.results).toEqual([expect.objectContaining({ outcome: 'repaired', repaired: ['outOfDate'] })]);
        expect(messageEdits(scenario).at(-1)?.body).toMatchObject({ flags: 0 });
        expect(rules.message(messageId).embedsSuppressed).toBe(false);
        expect(rules.messages.map((message) => message.id)).toEqual([messageId]);

        const after = await check(scenario, journey);
        expect(after.drifted).toEqual([]);
        expect(after.cleanKeys).toContain(PANEL_KEY);
    });

    it('refuses only the message it could not prepare, and still repairs the rest of the run — never a 500', async () => {
        const scenario = await startScenario();
        const installed = await install(scenario, houseJourney(scenario));
        const rules = scenario.guild.channel(appliedId(installed, RULES_KEY));
        const messageId = appliedId(installed, PANEL_KEY);
        const lounge = scenario.guild.channel(appliedId(installed, LOUNGE_KEY));

        const changed = houseJourney(scenario, {
            message: { content: 'Read these, then pick.', embeds: [{ title: 'House rules, revised' }] },
        });
        lounge.rename('hangout');
        const drift = await check(scenario, changed);
        expect(drift.drifted.map((report) => report.resourceKey).sort()).toEqual([LOUNGE_KEY, PANEL_KEY]);

        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        prepareMessageEditFault.fault = new Error('a bug past every refusal prepareMessageEdit knows about');
        const result = await repair(scenario, changed, drift, [PANEL_KEY, LOUNGE_KEY]);

        expect(result.refusal).toBeUndefined();
        expect(result.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    resourceKey: PANEL_KEY,
                    outcome: 'refused',
                    explanation: `"Rules panel" couldn't be prepared. Nothing was changed; try again.`,
                }),
                expect.objectContaining({ resourceKey: LOUNGE_KEY, outcome: 'repaired', repaired: ['renamed'] }),
            ])
        );
        expect(messageEdits(scenario)).toEqual([]);
        expect(rules.message(messageId).edited).toBe(false);
        expect(lounge.name).toBe('lounge');
    });

    it('lists a message the bot could not read as not checked — never clean, never offered for repair', async () => {
        const scenario = await startScenario();
        const { rules } = await installHouse(scenario);
        rules.refuseHistory();

        const drift = await check(scenario, houseJourney(scenario));

        expect(drift.cleanKeys).not.toContain(PANEL_KEY);
        expect(drift.drifted).toEqual([]);
        expect(drift.unchecked).toEqual([
            {
                resourceKey: PANEL_KEY,
                name: 'Rules panel',
                reason: expect.stringMatching(/^Couldn't check it in #rules: the bot can't even see it \(Missing Access\)/),
            },
        ]);
    });
});
