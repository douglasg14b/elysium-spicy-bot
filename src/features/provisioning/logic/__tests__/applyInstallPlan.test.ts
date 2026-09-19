import { ChannelType } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';

/**
 * The applier, which is the only code in this feature that mutates a guild.
 *
 * The property under test is the *ordering*, not the happy path: intent is recorded
 * before the guild is touched, so a crash between creating a channel and recording
 * its id leaves evidence rather than an orphan. That is invisible to a typecheck and
 * to any test that only asserts the end state, so the call sequence is asserted
 * directly.
 */

const calls: string[] = [];

let bindings: ResourceBindingEntity[] = [];
let nextBindingId = 1;
let settleResult = true;

const recordIntent = vi.fn(async (input: Record<string, string>) => {
    calls.push(`intent:${input.resourceKey}`);
    const existing = bindings.find(
        (binding) =>
            binding.guildId === input.guildId &&
            binding.journeyKey === input.journeyKey &&
            binding.resourceKey === input.resourceKey
    );
    if (existing) return existing;

    const created = {
        id: nextBindingId++,
        guildId: input.guildId,
        journeyKey: input.journeyKey,
        resourceKey: input.resourceKey,
        kind: input.kind,
        state: 'intended',
        discordId: null,
        name: input.name,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as unknown as ResourceBindingEntity;
    bindings.push(created);
    return created;
});

const settle = vi.fn(async (input: { id: number; discordId: string; state: string }) => {
    calls.push(`settle:${input.discordId}`);
    if (!settleResult) return false;
    const binding = bindings.find((candidate) => candidate.id === input.id);
    if (binding) {
        (binding as { discordId: string | null }).discordId = input.discordId;
        (binding as { state: string }).state = input.state;
    }
    return true;
});

const rebind = vi.fn(
    async (input: { id: number; expectedDiscordId: string; discordId: string; state: string }) => {
        calls.push(`rebind:${input.discordId}`);
        const binding = bindings.find(
            (candidate) => candidate.id === input.id && candidate.discordId === input.expectedDiscordId
        );
        if (!binding) return false;
        (binding as { discordId: string | null }).discordId = input.discordId;
        (binding as { state: string }).state = input.state;
        return true;
    }
);

const discardIntent = vi.fn(async (id: number) => {
    calls.push(`discard:${id}`);
    bindings = bindings.filter((binding) => binding.id !== id);
    return true;
});

vi.mock('../../data/resourceBindingsRepo', () => ({
    resourceBindingsRepo: {
        recordIntent: (input: Record<string, string>) => recordIntent(input),
        settle: (input: { id: number; discordId: string; state: string }) => settle(input),
        rebind: (input: {
            id: number;
            expectedDiscordId: string;
            discordId: string;
            state: string;
        }) => rebind(input),
        discardIntent: (id: number) => discardIntent(id),
        listByJourney: async () => bindings,
        get: async () => null,
    },
}));

const { applyInstallPlan } = await import('../applyInstallPlan');
const { buildInstallPlan } = await import('../installPlan');

interface FakeCreated {
    id: string;
    name: string;
    type: ChannelType;
}

function makeGuild(options: { failChannelCreate?: boolean } = {}) {
    const channels = new Map<string, FakeCreated>();
    let nextId = 100;

    return {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache: {
                has: (id: string) => channels.has(id),
                get: (id: string) => channels.get(id),
                filter: () => ({ map: () => [] }),
            },
            create: vi.fn(async (input: { name: string; type: ChannelType }) => {
                if (options.failChannelCreate) {
                    calls.push(`create-failed:${input.name}`);
                    throw new Error('Missing Permissions');
                }
                const id = `chan-${nextId++}`;
                calls.push(`create:${input.name}`);
                const created = { id, name: input.name, type: input.type };
                channels.set(id, created);
                return created;
            }),
        },
        roles: {
            everyone: { id: 'everyone-role' },
            cache: { has: () => true, filter: () => ({ map: () => [] }) },
            create: vi.fn(async (input: { name: string }) => {
                const id = `role-${nextId++}`;
                calls.push(`create:${input.name}`);
                return { id, name: input.name };
            }),
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

const JOURNEY = {
    journeyKey: 'onboarding',
    name: 'Onboarding',
    resources: [
        { key: 'arrivals-category', kind: 'category' as const, defaultName: 'Arrivals' },
        {
            key: 'welcome-channel',
            kind: 'textChannel' as const,
            defaultName: 'welcome',
            parentKey: 'arrivals-category',
        },
    ],
};

beforeEach(() => {
    calls.length = 0;
    bindings = [];
    nextBindingId = 1;
    settleResult = true;
    vi.clearAllMocks();
});

describe('applyInstallPlan', () => {
    it('records intent before mutating the guild, and settles after', async () => {
        // The crash-safety requirement, asserted as a sequence. Any reordering here
        // reintroduces the orphan window.
        const guild = makeGuild();
        const plan = buildInstallPlan({ guild, journey: JOURNEY, existingBindings: [] });

        const result = await applyInstallPlan({
            guild,
            journey: JOURNEY,
            plan,
            staffRoleIds: ['role-staff'],
        });

        expect(result.failure).toBeUndefined();
        expect(calls).toEqual([
            'intent:arrivals-category',
            'create:Arrivals',
            'settle:chan-100',
            'intent:welcome-channel',
            'create:welcome',
            'settle:chan-101',
        ]);
    });

    it('creates a parent category before the channel that names it', async () => {
        const guild = makeGuild();
        const plan = buildInstallPlan({ guild, journey: JOURNEY, existingBindings: [] });

        const result = await applyInstallPlan({
            guild,
            journey: JOURNEY,
            plan,
            staffRoleIds: [],
        });

        expect(result.applied.map((entry) => entry.resourceKey)).toEqual([
            'arrivals-category',
            'welcome-channel',
        ]);
    });

    it('discards the intent row when the guild mutation fails', async () => {
        // The guild was not changed, so a lingering `intended` row would make the
        // next plan believe a resource is half-created.
        const guild = makeGuild({ failChannelCreate: true });
        const plan = buildInstallPlan({ guild, journey: JOURNEY, existingBindings: [] });

        const result = await applyInstallPlan({
            guild,
            journey: JOURNEY,
            plan,
            staffRoleIds: [],
        });

        expect(result.failure).toMatch(/Missing Permissions/);
        expect(calls).toContain('discard:1');
        expect(bindings).toHaveLength(0);
    });

    it('stops at the first failure and reports what did succeed', async () => {
        // Partial application is a legitimate state: what was applied is real and
        // bound, and must not be silently rolled back.
        const guild = makeGuild();
        const plan = buildInstallPlan({ guild, journey: JOURNEY, existingBindings: [] });

        // Let the category succeed, then fail the channel. The replacement must
        // still populate the channel cache, or the parent lookup fails first and
        // this stops testing what it claims to.
        const guildChannels = (
            guild as never as {
                channels: {
                    create: unknown;
                    cache: { has: (id: string) => boolean; get: (id: string) => unknown };
                };
            }
        ).channels;
        const realCreate = guildChannels.create as (input: {
            name: string;
            type: ChannelType;
        }) => Promise<unknown>;

        let createCount = 0;
        guildChannels.create = vi.fn(async (input: { name: string; type: ChannelType }) => {
            createCount += 1;
            if (createCount > 1) throw new Error('rate limited');
            return realCreate(input);
        });

        const result = await applyInstallPlan({
            guild,
            journey: JOURNEY,
            plan,
            staffRoleIds: [],
        });

        expect(result.failure).toMatch(/rate limited/);
        expect(result.applied.map((entry) => entry.resourceKey)).toEqual(['arrivals-category']);
    });

    it('recreates a resource whose binding points at something deleted', async () => {
        // The stale binding is settled, so a naive "already bound, therefore
        // converging" check short-circuits and reports success while the channel is
        // never recreated — leaving a binding that resolves to a dead snowflake and
        // would be written into node configs as one.
        const guild = makeGuild();
        bindings = [
            {
                id: 99,
                guildId: 'guild-1',
                journeyKey: 'onboarding',
                resourceKey: 'arrivals-category',
                kind: 'category',
                state: 'created',
                discordId: 'chan-gone',
                name: 'Arrivals',
                createdAt: new Date(),
                updatedAt: new Date(),
            } as unknown as ResourceBindingEntity,
        ];
        nextBindingId = 100;

        const plan = buildInstallPlan({ guild, journey: JOURNEY, existingBindings: bindings });
        expect(plan.items[0].action).toBe('create');

        const result = await applyInstallPlan({
            guild,
            journey: JOURNEY,
            plan,
            staffRoleIds: [],
        });

        const category = result.applied.find((entry) => entry.resourceKey === 'arrivals-category');
        expect(category?.action).toBe('created');
        expect(category?.discordId).not.toBe('chan-gone');
        expect(calls).toContain('create:Arrivals');
    });

    it('refuses to adopt a resource deleted between approval and apply', async () => {
        // The plan verified this id when it was built, but approval takes time.
        const guild = makeGuild();
        const plan = {
            guildId: 'guild-1',
            journeyKey: 'onboarding',
            items: [
                {
                    resourceKey: 'arrivals-category',
                    kind: 'category' as const,
                    action: 'adopt' as const,
                    name: 'Arrivals',
                    discordId: 'chan-vanished',
                },
            ],
            blockers: [],
        };

        const result = await applyInstallPlan({
            guild,
            journey: { ...JOURNEY, resources: [JOURNEY.resources[0]] },
            plan,
            staffRoleIds: [],
        });

        expect(result.failure).toMatch(/no longer exists/i);
        expect(result.applied).toHaveLength(0);
        // The intent row must not survive a mutation that never happened.
        expect(bindings).toHaveLength(0);
    });

    it('refuses to apply a plan that has blocked items', async () => {
        const guild = makeGuild();
        const plan = buildInstallPlan({
            guild,
            journey: JOURNEY,
            existingBindings: [],
            choices: { 'welcome-channel': { adoptDiscordId: 'chan-ghost' } },
        });

        const result = await applyInstallPlan({
            guild,
            journey: JOURNEY,
            plan,
            staffRoleIds: [],
        });

        expect(result.failure).toMatch(/unresolved items or blockers/i);
        expect(result.applied).toHaveLength(0);
        // Nothing was recorded and nothing was created.
        expect(calls).toHaveLength(0);
    });

    it('reports a duplicate rather than deleting it when a concurrent install wins', async () => {
        // Deleting the resource we just made would be a destructive action taken
        // without confirmation, so it is reported for a human instead.
        settleResult = false;
        const guild = makeGuild();
        const plan = buildInstallPlan({ guild, journey: JOURNEY, existingBindings: [] });

        const result = await applyInstallPlan({
            guild,
            journey: JOURNEY,
            plan,
            staffRoleIds: [],
        });

        expect(result.failure).toMatch(/concurrent install/i);
        expect(result.failure).toMatch(/removed by hand/i);
    });
});
