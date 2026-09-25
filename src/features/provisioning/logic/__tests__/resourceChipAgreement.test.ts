import { ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { detectResourceProblems } from '../../../../../web/src/flows/detectResourceProblems';
import { RESOURCE_CHIPS } from '../../../../../web/src/flows/resourceChips';
import type {
    GuildChannel as BrowserGuildChannel,
    GuildRole as BrowserGuildRole,
    ResourceDeclaration as BrowserResourceDeclaration,
} from '../../../../../web/src/api/types';
import { resourceSchema } from '../../../../web/api/journeyRoutes';
import { declaredRoleReference } from '../declaredRoleReference';
import { buildInstallPlan } from '../installPlan';
import { validateJourneyDeclaration, type JourneyDeclaration } from '../resourceDeclaration';

/**
 * The red chips are a promise about the server, and this is where the promise is kept.
 *
 * `web/src/flows/detectResourceProblems.ts` says, of some declarations, "the save will
 * refuse this". It cannot call the code that would refuse — a `src/` import inside
 * `web/` drags the bot tree into `tsc -b` and breaks `pnpm build:web`, which is the
 * trade `web/src/api/types.ts` documents — so it re-implements the rules, and this
 * test holds the two halves equal instead of the compiler.
 *
 * It lives on the **server** side of the boundary because imports run that way: a test
 * under `src/` may read `web/`, as `nodeDescriptorDrift.test.ts` and
 * `declaredRoleReference.test.ts` already do. The reverse is what breaks the build.
 *
 * Both directions are asserted, and the second is the one that matters more:
 *
 *  - a declaration the detector calls an **error** must really be rejected — otherwise
 *    a red chip blocks an operator from saving something that would have worked;
 *  - a declaration the detector calls **clean** must really be accepted — otherwise the
 *    save fails with a server banner on a modal showing no problems at all, which is
 *    the state this whole vocabulary exists to prevent.
 */

/** What the server does with a declaration: both gates, in the order the route runs them. */
type ServerVerdict = { accepted: true } | { accepted: false; reason: string };

function serverVerdict(resources: readonly BrowserResourceDeclaration[]): ServerVerdict {
    // Gate one: the Zod schema on each resource. The route parses the array, so one
    // bad member rejects the whole save.
    for (const resource of resources) {
        const parsed = resourceSchema.safeParse(resource);
        if (!parsed.success) {
            return { accepted: false, reason: parsed.error.issues[0]?.message ?? 'schema' };
        }
    }

    // Gate two: the whole-journey invariants, which are the ones no single resource
    // can answer. The journey key is the flow's own id on the real path.
    const journey: JourneyDeclaration = {
        journeyKey: 'flow-1',
        name: 'Flow 1',
        resources: resources as JourneyDeclaration['resources'],
    };

    try {
        validateJourneyDeclaration(journey);
        return { accepted: true };
    } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : 'unknown' };
    }
}

/** Whether the browser would put at least one red chip on this list. */
function browserSeesError(resources: readonly BrowserResourceDeclaration[]): boolean {
    return detectResourceProblems(resources).some((entry) =>
        entry.chips.some((chip) => RESOURCE_CHIPS[chip.id].tone === 'error')
    );
}

function channel(
    overrides: Partial<BrowserResourceDeclaration> = {}
): BrowserResourceDeclaration {
    return { key: 'questions', kind: 'textChannel', defaultName: 'questions', ...overrides };
}

/**
 * Declarations the server refuses, each named by the chip that should have warned.
 *
 * Every error-tier chip appears here at least once. A chip with no row is a claim
 * nothing has checked.
 */
const REJECTED: readonly { chip: string; resources: BrowserResourceDeclaration[] }[] = [
    {
        chip: 'duplicateKey',
        resources: [channel({ key: 'aftercare' }), channel({ key: 'aftercare' })],
    },
    {
        chip: 'duplicateAdoption',
        resources: [
            channel({ key: 'rules', adoptDiscordId: '100000000000000001' }),
            channel({ key: 'rules-copy', adoptDiscordId: '100000000000000001' }),
        ],
    },
    { chip: 'invalidKey (underscore)', resources: [channel({ key: 'qa_channel' })] },
    { chip: 'invalidKey (uppercase)', resources: [channel({ key: 'QaChannel' })] },
    { chip: 'invalidKey (empty)', resources: [channel({ key: '' })] },
    { chip: 'invalidKey (too long)', resources: [channel({ key: 'a'.repeat(65) })] },
    { chip: 'invalidKey (empty name)', resources: [channel({ defaultName: '' })] },
    { chip: 'invalidKey (name too long)', resources: [channel({ defaultName: 'x'.repeat(101) })] },
    {
        chip: 'ruleNamesNoRole (no ids)',
        resources: [
            channel({ permissions: [{ audience: 'roles', roleIds: [], access: 'readWrite' }] }),
        ],
    },
    {
        chip: 'ruleNamesNoRole (undeclared key)',
        resources: [
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('deleted-role')],
                        access: 'readWrite',
                    },
                ],
            }),
        ],
    },
    {
        chip: 'ruleNamesNoRole (key is not a role)',
        resources: [
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('arrivals')],
                        access: 'readWrite',
                    },
                ],
            }),
        ],
    },
];

/**
 * Declarations the server accepts — including every *warning* case.
 *
 * The amber tier is the delicate half. `permissions: []`, a `subject` audience and an
 * adopted resource carrying rules are all saveable and installable; promoting any of
 * them to red would block a save the server would have honoured.
 */
const ACCEPTED: readonly { name: string; resources: BrowserResourceDeclaration[] }[] = [
    { name: 'a plain created channel', resources: [channel()] },
    {
        name: 'a channel inside a declared category',
        resources: [
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
            channel({ parentKey: 'arrivals' }),
        ],
    },
    { name: 'permissions: [] — nobody can see this', resources: [channel({ permissions: [] })] },
    {
        name: 'a subject audience — per-run only',
        resources: [channel({ permissions: [{ audience: 'subject', access: 'readWrite' }] })],
    },
    {
        name: 'an adopted channel carrying rules — permissions untouched',
        resources: [
            channel({
                adoptDiscordId: '100000000000000001',
                permissions: [{ audience: 'everyone', access: 'hidden' }],
            }),
        ],
    },
    {
        name: 'a rule naming a role the flow declares',
        resources: [
            { key: 'in-approval', kind: 'role', defaultName: 'In Approval' },
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('in-approval')],
                        access: 'readWrite',
                    },
                ],
            }),
        ],
    },
    {
        name: 'a rule naming a real guild role by snowflake',
        resources: [
            channel({
                permissions: [
                    { audience: 'roles', roleIds: ['847263518290110'], access: 'readWrite' },
                ],
            }),
        ],
    },
    {
        name: 'two channels adopting different objects',
        resources: [
            channel({ key: 'rules', adoptDiscordId: '100000000000000001' }),
            channel({ key: 'welcome', adoptDiscordId: '100000000000000002' }),
        ],
    },
    { name: 'a key at exactly the 64-character cap', resources: [channel({ key: 'a'.repeat(64) })] },
    {
        name: 'a name at exactly the 100-character cap',
        resources: [channel({ defaultName: 'x'.repeat(100) })],
    },
];

describe('red chips agree with the server', () => {
    it.each(REJECTED)('the server really rejects what $chip claims it will', ({ resources }) => {
        expect(serverVerdict(resources).accepted).toBe(false);
    });

    it.each(REJECTED)('the browser flags $chip before the save is attempted', ({ resources }) => {
        expect(browserSeesError(resources)).toBe(true);
    });
});

describe('the absence of a red chip agrees with the server', () => {
    it.each(ACCEPTED)('the server accepts $name', ({ resources }) => {
        const verdict = serverVerdict(resources);
        expect(verdict.accepted, verdict.accepted ? '' : verdict.reason).toBe(true);
    });

    it.each(ACCEPTED)('the browser shows no red chip on $name', ({ resources }) => {
        expect(browserSeesError(resources)).toBe(false);
    });
});

/**
 * The third tier, and the one whose claim the two above cannot make.
 *
 * `blocksInstall` says "the save takes this, the install will not", so neither existing
 * assertion covers it: `serverVerdict` only runs the save gates, which accept it, and a
 * red-chip check would be asserting the opposite of the truth. Checking it needs the
 * real `buildInstallPlan` against a guild, which is why this block exists rather than a
 * row in `REJECTED`.
 *
 * The same rule applies as for the red tier: **a chip with no row here is a claim
 * nothing has checked.** `nameTaken` is currently the only member.
 */

/** A guild holding one channel and one role, both named so a declaration can collide. */
function guildWith(channelNames: readonly string[], roleNames: readonly string[]) {
    const channels = channelNames.map((name, index) => ({
        id: `channel-${index}`,
        name,
        type: ChannelType.GuildText,
    }));
    const roles = [
        { id: 'role-staff', name: 'Staff' },
        ...roleNames.map((name, index) => ({ id: `role-${index}`, name })),
    ];

    const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
    const roleMap = new Map(roles.map((role) => [role.id, role]));

    return {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache: {
                has: (id: string) => channelMap.has(id),
                get: (id: string) => channelMap.get(id),
                filter: (fn: (channel: (typeof channels)[number]) => boolean) => ({
                    map: <T,>(project: (channel: (typeof channels)[number]) => T) =>
                        [...channelMap.values()].filter(fn).map(project),
                }),
            },
        },
        roles: {
            everyone: { id: 'everyone-role' },
            cache: {
                has: (id: string) => roleMap.has(id),
                filter: (fn: (role: { id: string; name: string }) => boolean) => ({
                    map: <T,>(project: (role: { id: string; name: string }) => T) =>
                        [...roleMap.values()].filter(fn).map(project),
                }),
            },
        },
        members: {
            me: {
                id: 'bot-member',
                permissions: { has: () => true },
                roles: { highest: { position: 5 } },
            },
        },
    } as never;
}

/** Whether the browser would put an install-blocking chip on this list. */
function browserSeesInstallBlocker(
    resources: readonly BrowserResourceDeclaration[],
    guild: { channels: BrowserGuildChannel[]; roles: BrowserGuildRole[] }
): boolean {
    return detectResourceProblems(resources, guild).some((entry) =>
        entry.chips.some((chip) => RESOURCE_CHIPS[chip.id].tone === 'blocksInstall')
    );
}

describe('install-blocking chips agree with the install planner', () => {
    const COLLIDING_NAME = 'welcome';

    const browserGuild = {
        channels: [
            {
                id: 'channel-0',
                name: COLLIDING_NAME,
                type: 'text' as const,
                parentId: null,
                parentName: null,
            },
        ],
        roles: [],
    };

    const resources: BrowserResourceDeclaration[] = [
        channel({ key: 'welcome', defaultName: COLLIDING_NAME }),
    ];

    it('the save really accepts what nameTaken claims it will', () => {
        // The whole reason this is not an `error`. Calling it red would block a save
        // the server would have honoured, which is the failure the red tier's
        // credibility rests on not making.
        const verdict = serverVerdict(resources);
        expect(verdict.accepted, verdict.accepted ? '' : verdict.reason).toBe(true);
    });

    it('the install really blocks what nameTaken claims it will', () => {
        const plan = buildInstallPlan({
            guild: guildWith([COLLIDING_NAME], []),
            journey: {
                journeyKey: 'flow-1',
                name: 'Flow 1',
                resources: resources as JourneyDeclaration['resources'],
            },
            existingBindings: [],
        });

        const item = plan.items.find((candidate) => candidate.resourceKey === 'welcome');
        expect(item?.action).toBe('blocked');
    });

    it('the browser flags it before the install is attempted', () => {
        expect(browserSeesInstallBlocker(resources, browserGuild)).toBe(true);
    });

    it('does not flag a name nothing in the guild has', () => {
        expect(
            browserSeesInstallBlocker(
                [channel({ key: 'arrivals', defaultName: 'arrivals' })],
                browserGuild
            )
        ).toBe(false);
    });

    it('does not flag a colliding name the row actually adopts', () => {
        // Adopting is the resolution, not the problem — and the install agrees, since
        // an `adoptDiscordId` short-circuits the name lookup entirely.
        expect(
            browserSeesInstallBlocker(
                [
                    channel({
                        key: 'welcome',
                        defaultName: COLLIDING_NAME,
                        adoptDiscordId: 'channel-0',
                    }),
                ],
                browserGuild
            )
        ).toBe(false);
    });

    it('stays silent when no guild directory was supplied', () => {
        // Absent means "we could not find out". A row is not flagged for colliding
        // with a directory nobody loaded.
        expect(
            detectResourceProblems(resources).some((entry) =>
                entry.chips.some((chip) => RESOURCE_CHIPS[chip.id].tone === 'blocksInstall')
            )
        ).toBe(false);
    });
});
