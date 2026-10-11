import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import type { GuildOwnership } from '../bindingOwner';
import type { ResourceKind } from '../resourceDeclaration';
import {
    buildUnpublishPlan,
    plannedDeletions,
    plannedRefusals,
    type BuildUnpublishPlanInput,
    type UnpublishPlan,
} from '../unpublishPlan';

/**
 * The teardown rules, which are the most destructive code in this repo.
 *
 * Two of these tests guard promises rather than behaviour, and both have been
 * sabotage-verified — the guard was removed, the named test failed, the guard was
 * restored:
 *
 *  - **`never plans a delete for an adopted binding`** — adoption is the promise that
 *    we will not touch structure the operator already had.
 *  - **`refuses a category whose adopted child would be cascaded`** — Discord deletes
 *    a category's children with it, so the category path is a second route to breaking
 *    the first promise, and it has to be closed separately.
 */

interface FakeChannel {
    readonly id: string;
    readonly name: string;
    readonly type: ChannelType;
    readonly parentId: string | null;
}

interface FakeRole {
    readonly id: string;
    readonly name: string;
    readonly position: number;
}

interface MakeGuildOptions {
    readonly channels?: readonly FakeChannel[];
    readonly roles?: readonly FakeRole[];
    readonly permissions?: readonly bigint[];
    readonly botRolePosition?: number;
    readonly botCached?: boolean;
}

function textChannel(id: string, name: string, parentId: string | null = null): FakeChannel {
    return { id, name, type: ChannelType.GuildText, parentId };
}

function category(id: string, name: string): FakeChannel {
    return { id, name, type: ChannelType.GuildCategory, parentId: null };
}

/**
 * A guild whose `channels.cache` supports `get` and `filter().map()`.
 *
 * `filter` has to return something with `map` because that is the shape
 * `survivorsOf` uses, and discord.js Collections chain that way.
 */
function makeGuild(options: MakeGuildOptions = {}): Guild {
    const channels = options.channels ?? [];
    const roles = options.roles ?? [];
    const permissions = options.permissions ?? [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
    ];

    const channelById = new Map(channels.map((channel) => [channel.id, channel] as const));
    const roleById = new Map(roles.map((role) => [role.id, role] as const));

    return {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache: {
                get: (id: string) => channelById.get(id),
                has: (id: string) => channelById.has(id),
                filter: (predicate: (channel: FakeChannel) => boolean) => ({
                    map: <TMapped,>(mapper: (channel: FakeChannel) => TMapped) =>
                        channels.filter(predicate).map(mapper),
                }),
            },
        },
        roles: {
            cache: {
                get: (id: string) => roleById.get(id),
                has: (id: string) => roleById.has(id),
            },
        },
        members: options.botCached === false
            ? { me: null }
            : {
                  me: {
                      id: 'bot-member',
                      permissions: {
                          has: (flag: bigint) => permissions.includes(flag),
                      },
                      roles: { highest: { position: options.botRolePosition ?? 10 } },
                  },
              },
    } as never;
}

let nextBindingId = 1;

function binding(overrides: Partial<ResourceBindingEntity> = {}): ResourceBindingEntity {
    return {
        id: nextBindingId++,
        guildId: 'guild-1',
        ownerKind: 'journey',
        ownerKey: 'journey-1',
        resourceKey: 'some-resource',
        kind: 'textChannel' as ResourceKind,
        state: 'created',
        discordId: 'channel-1',
        name: 'some-channel',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as ResourceBindingEntity;
}

/**
 * The plan, for a guild whose only bindings are the journey's own unless `ownership` says
 * otherwise — what every test here before 2026-10-10 assumed without having to say it.
 */
function planFor(
    input: Omit<BuildUnpublishPlanInput, 'ownership'> & { readonly ownership?: GuildOwnership }
): UnpublishPlan {
    return buildUnpublishPlan({
        ...input,
        ownership: input.ownership ?? { bindings: input.bindings, journeyNames: new Map() },
    });
}

function itemFor(plan: ReturnType<typeof buildUnpublishPlan>, resourceKey: string) {
    const found = plan.items.find((item) => item.resourceKey === resourceKey);
    if (!found) throw new Error(`No plan item for "${resourceKey}"`);
    return found;
}

describe('the adoption promise', () => {
    it('never plans a delete for an adopted binding', () => {
        const plan = planFor({
            guild: makeGuild({ channels: [textChannel('channel-adopted', 'general')] }),
            journeyKey: 'journey-1',
            bindings: [
                binding({
                    resourceKey: 'theirs',
                    state: 'adopted',
                    discordId: 'channel-adopted',
                    name: 'general',
                }),
            ],
        });

        expect(itemFor(plan, 'theirs').action).toBe('refuse');
        expect(itemFor(plan, 'theirs').refusalReason).toBe('adopted');
        // The property that matters, stated over the whole plan rather than one item:
        // no route through this function may produce a delete for an adopted row.
        expect(plannedDeletions(plan)).toEqual([]);
    });

    it('refuses an adopted role just as firmly as an adopted channel', () => {
        const plan = planFor({
            guild: makeGuild({ roles: [{ id: 'role-mod', name: 'Moderator', position: 3 }] }),
            journeyKey: 'journey-1',
            bindings: [
                binding({
                    resourceKey: 'mod-role',
                    kind: 'role',
                    state: 'adopted',
                    discordId: 'role-mod',
                    name: 'Moderator',
                }),
            ],
        });

        expect(itemFor(plan, 'mod-role').action).toBe('refuse');
        expect(plannedDeletions(plan)).toEqual([]);
    });

    it('still refuses an adopted binding whose object is already gone', () => {
        // Reported as a refusal rather than quietly forgotten: the operator asked what
        // this would do to their server, and "we are leaving your channel alone" is a
        // different answer from "we tidied up a stale record".
        const plan = planFor({
            guild: makeGuild(),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'theirs', state: 'adopted', discordId: 'channel-gone' }),
            ],
        });

        expect(itemFor(plan, 'theirs').action).toBe('refuse');
        expect(itemFor(plan, 'theirs').refusalReason).toBe('adopted');
    });
});

describe('the category cascade', () => {
    it('refuses a category whose adopted child would be cascaded, and names it', () => {
        const plan = planFor({
            guild: makeGuild({
                channels: [
                    category('cat-1', 'Support'),
                    textChannel('channel-ours', 'tickets', 'cat-1'),
                    textChannel('channel-theirs', 'announcements', 'cat-1'),
                ],
            }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Support' }),
                binding({ resourceKey: 'ours', discordId: 'channel-ours', name: 'tickets' }),
                binding({
                    resourceKey: 'theirs',
                    state: 'adopted',
                    discordId: 'channel-theirs',
                    name: 'announcements',
                }),
            ],
        });

        const categoryItem = itemFor(plan, 'cat');
        expect(categoryItem.action).toBe('refuse');
        expect(categoryItem.refusalReason).toBe('category-has-survivors');
        // Named, not counted. A count is not something an operator can go and check.
        expect(categoryItem.survivors).toEqual(['announcements']);
        expect(categoryItem.explanation).toContain('announcements');

        // The rest of the run still proceeds — one blocked category must not abandon
        // the whole operation.
        expect(itemFor(plan, 'ours').action).toBe('delete');
    });

    it('refuses a category holding a hand-made channel that has no binding at all', () => {
        // The case that proves survivors are read from the guild rather than from the
        // binding table: nothing in our records has ever heard of this channel, and it
        // is exactly the one that must block.
        const plan = planFor({
            guild: makeGuild({
                channels: [
                    category('cat-1', 'Support'),
                    textChannel('channel-ours', 'tickets', 'cat-1'),
                    textChannel('channel-handmade', 'random-chat', 'cat-1'),
                ],
            }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Support' }),
                binding({ resourceKey: 'ours', discordId: 'channel-ours', name: 'tickets' }),
            ],
        });

        expect(itemFor(plan, 'cat').action).toBe('refuse');
        expect(itemFor(plan, 'cat').survivors).toEqual(['random-chat']);
    });

    it('refuses a category holding another journey\'s channel', () => {
        // Another journey's binding is not in *this* journey's binding list, so it is
        // simply not in the delete set and survives. No special case needed, which is
        // the point — the rule is "not being deleted by this run", not "unknown".
        const plan = planFor({
            guild: makeGuild({
                channels: [
                    category('cat-1', 'Support'),
                    textChannel('channel-other', 'other-journey-channel', 'cat-1'),
                ],
            }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Support' }),
            ],
        });

        expect(itemFor(plan, 'cat').action).toBe('refuse');
        expect(itemFor(plan, 'cat').survivors).toEqual(['other-journey-channel']);
    });

    it('proceeds when every child is in the same unpublish set', () => {
        const plan = planFor({
            guild: makeGuild({
                channels: [
                    category('cat-1', 'Support'),
                    textChannel('channel-a', 'tickets', 'cat-1'),
                    textChannel('channel-b', 'archive', 'cat-1'),
                ],
            }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Support' }),
                binding({ resourceKey: 'a', discordId: 'channel-a', name: 'tickets' }),
                binding({ resourceKey: 'b', discordId: 'channel-b', name: 'archive' }),
            ],
        });

        expect(plannedRefusals(plan)).toEqual([]);
        expect(plannedDeletions(plan)).toHaveLength(3);
    });

    it('deletes an empty category', () => {
        const plan = planFor({
            guild: makeGuild({ channels: [category('cat-1', 'Empty')] }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Empty' }),
            ],
        });

        expect(itemFor(plan, 'cat').action).toBe('delete');
    });
});

describe('ordering', () => {
    it('places children before parents even when the bindings arrive parent-first', () => {
        // The ordering is what lets a category see its children already in the delete
        // set. Declared parent-first on purpose, so a sort that did nothing would fail.
        const plan = planFor({
            guild: makeGuild({
                channels: [category('cat-1', 'Support'), textChannel('channel-a', 'tickets', 'cat-1')],
            }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Support' }),
                binding({ resourceKey: 'a', discordId: 'channel-a', name: 'tickets' }),
            ],
        });

        const keys = plan.items.map((item) => item.resourceKey);
        expect(keys.indexOf('a')).toBeLessThan(keys.indexOf('cat'));
    });
});

describe('rows with nothing behind them', () => {
    it('forgets an intended binding without touching the guild', () => {
        const plan = planFor({
            guild: makeGuild(),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'pending', state: 'intended', discordId: null }),
            ],
        });

        expect(itemFor(plan, 'pending').action).toBe('forget');
        expect(plannedDeletions(plan)).toEqual([]);
    });

    it('forgets a created binding whose object is already gone', () => {
        // Not a failure: the desired state is "this channel is not in the server", and
        // it already holds.
        const plan = planFor({
            guild: makeGuild(),
            journeyKey: 'journey-1',
            bindings: [binding({ resourceKey: 'vanished', discordId: 'channel-deleted-by-hand' })],
        });

        expect(itemFor(plan, 'vanished').action).toBe('forget');
    });

    it('forgets a binding whose id now names a different kind of object', () => {
        // `existsInGuildAs` checks the type, so a snowflake reused for something else
        // is not "still there". Deleting it would destroy an unrelated object.
        const plan = planFor({
            guild: makeGuild({ channels: [category('channel-1', 'Now A Category')] }),
            journeyKey: 'journey-1',
            bindings: [binding({ resourceKey: 'moved', kind: 'textChannel', discordId: 'channel-1' })],
        });

        expect(itemFor(plan, 'moved').action).toBe('forget');
    });
});

describe('permission preflight', () => {
    it('refuses a channel delete without Manage Channels, before anything is confirmed', () => {
        const plan = planFor({
            guild: makeGuild({
                channels: [textChannel('channel-1', 'tickets')],
                permissions: [PermissionFlagsBits.ManageRoles],
            }),
            journeyKey: 'journey-1',
            bindings: [binding({ resourceKey: 'chan', discordId: 'channel-1' })],
        });

        expect(itemFor(plan, 'chan').action).toBe('refuse');
        expect(itemFor(plan, 'chan').refusalReason).toBe('missing-permission');
        expect(itemFor(plan, 'chan').explanation).toContain('Manage Channels');
    });

    it('lets channels proceed when only Manage Roles is missing', () => {
        // Reported per item rather than as a plan-level blocker: the two permissions
        // are independent, and a missing one must not strand the other half.
        const plan = planFor({
            guild: makeGuild({
                channels: [textChannel('channel-1', 'tickets')],
                roles: [{ id: 'role-1', name: 'Helper', position: 2 }],
                permissions: [PermissionFlagsBits.ManageChannels],
            }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'chan', discordId: 'channel-1' }),
                binding({ resourceKey: 'rol', kind: 'role', discordId: 'role-1' }),
            ],
        });

        expect(itemFor(plan, 'chan').action).toBe('delete');
        expect(itemFor(plan, 'rol').action).toBe('refuse');
    });

    it('refuses a role sitting above the bot', () => {
        const plan = planFor({
            guild: makeGuild({
                roles: [{ id: 'role-1', name: 'Admin', position: 20 }],
                botRolePosition: 10,
            }),
            journeyKey: 'journey-1',
            bindings: [binding({ resourceKey: 'rol', kind: 'role', discordId: 'role-1' })],
        });

        expect(itemFor(plan, 'rol').action).toBe('refuse');
        expect(itemFor(plan, 'rol').explanation).toContain('highest role');
    });

    it('refuses to delete @everyone', () => {
        const plan = planFor({
            guild: makeGuild({ roles: [{ id: 'guild-1', name: '@everyone', position: 0 }] }),
            journeyKey: 'journey-1',
            bindings: [binding({ resourceKey: 'rol', kind: 'role', discordId: 'guild-1' })],
        });

        expect(itemFor(plan, 'rol').action).toBe('refuse');
        expect(itemFor(plan, 'rol').explanation).toContain('@everyone');
    });

    it('refuses everything when the bot member is not cached', () => {
        // Guessing at permissions we cannot read is worse than refusing, and this is a
        // destructive operation.
        const plan = planFor({
            guild: makeGuild({ channels: [textChannel('channel-1', 'tickets')], botCached: false }),
            journeyKey: 'journey-1',
            bindings: [binding({ resourceKey: 'chan', discordId: 'channel-1' })],
        });

        expect(itemFor(plan, 'chan').action).toBe('refuse');
        expect(plannedDeletions(plan)).toEqual([]);
    });
});

describe('another owner holds it too', () => {
    /** The ticket feature's row for a slot, pointed at `discordId`. */
    function ticketSlot(discordId: string): ResourceBindingEntity {
        return binding({
            ownerKind: 'tickets',
            ownerKey: 'tickets',
            resourceKey: 'open',
            kind: 'category',
            state: 'adopted',
            discordId,
            name: 'Tickets',
        });
    }

    it('forgets an empty created category tickets use, rather than deleting it', () => {
        // Sabotage-verified: removing the shared-owner branch in `buildUnpublishPlan`
        // turns this into a `delete` — the category is empty, so no survivor stops it.
        const ours = binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Arrivals' });
        const plan = planFor({
            guild: makeGuild({ channels: [category('cat-1', 'Arrivals')] }),
            journeyKey: 'journey-1',
            bindings: [ours],
            ownership: { bindings: [ours, ticketSlot('cat-1')], journeyNames: new Map() },
        });

        expect(itemFor(plan, 'cat').action).toBe('forget');
        expect(itemFor(plan, 'cat').explanation).toContain('the ticket system');
        expect(plannedDeletions(plan)).toEqual([]);
    });

    it('forgets it even without Manage Channels, since a forget touches nothing in Discord', () => {
        const ours = binding({ resourceKey: 'cat', kind: 'category', discordId: 'cat-1', name: 'Arrivals' });
        const plan = planFor({
            guild: makeGuild({
                channels: [category('cat-1', 'Arrivals')],
                permissions: [PermissionFlagsBits.ManageRoles],
            }),
            journeyKey: 'journey-1',
            bindings: [ours],
            ownership: { bindings: [ours, ticketSlot('cat-1')], journeyNames: new Map() },
        });

        expect(itemFor(plan, 'cat').action).toBe('forget');
    });

    it('names another journey by its display name', () => {
        const ours = binding({ resourceKey: 'chan', discordId: 'channel-1' });
        const theirs = binding({ ownerKey: 'journey-2', resourceKey: 'lobby', state: 'adopted', discordId: 'channel-1' });
        const plan = planFor({
            guild: makeGuild({ channels: [textChannel('channel-1', 'lobby')] }),
            journeyKey: 'journey-1',
            bindings: [ours],
            ownership: { bindings: [ours, theirs], journeyNames: new Map([['journey-2', 'Welcome Wagon']]) },
        });

        expect(itemFor(plan, 'chan').action).toBe('forget');
        expect(itemFor(plan, 'chan').explanation).toContain('journey "Welcome Wagon"');
    });

    it('does not pin an interrupted create on a same-named category the ticket system holds', () => {
        // The recovery fence reads every owner's ids now, not this journey's alone.
        const createdAt = new Date();
        const ticketCategoryId = String((BigInt(createdAt.getTime() + 1_000) - 1420070400000n) << 22n);
        const intent = binding({
            resourceKey: 'cat',
            kind: 'category',
            state: 'intended',
            discordId: null,
            name: 'Tickets',
            createdAt,
        });
        const plan = planFor({
            guild: makeGuild({ channels: [category(ticketCategoryId, 'Tickets')] }),
            journeyKey: 'journey-1',
            bindings: [intent],
            ownership: { bindings: [intent, ticketSlot(ticketCategoryId)], journeyNames: new Map() },
        });

        expect(itemFor(plan, 'cat').action).toBe('forget');
        expect(itemFor(plan, 'cat').refusalReason).toBeUndefined();
    });
});

/**
 * Douglas's rule (2026-10-10): uninstalling a journey never removes a setting it
 * installed. A ticket type's row is forgotten in every state; the type stays.
 */
describe('a ticket type', () => {
    it.each(['created', 'adopted'] as const)('is forgotten, never deleted, when this journey %s it', (state) => {
        const plan = planFor({
            // No Manage Channels or Roles either: a forget asks Discord for nothing.
            guild: makeGuild({ permissions: [] }),
            journeyKey: 'journey-1',
            bindings: [
                binding({ resourceKey: 'verify', kind: 'ticketType', state, discordId: 'verify', name: 'Verification' }),
            ],
        });

        expect(itemFor(plan, 'verify')).toMatchObject({ action: 'forget', kind: 'ticketType' });
        expect(itemFor(plan, 'verify').explanation).toMatch(/stays, and flows that use it keep working/);
        // The key is no snowflake, so the item carries none.
        expect(itemFor(plan, 'verify').discordId).toBeUndefined();
        expect(plannedDeletions(plan)).toEqual([]);
        expect(plannedRefusals(plan)).toEqual([]);
    });

    it('is forgotten even when its key is all digits and names a channel in the guild', () => {
        const plan = planFor({
            guild: makeGuild({ channels: [textChannel('123456789012345678', 'lobby')] }),
            journeyKey: 'journey-1',
            bindings: [binding({ resourceKey: 'desk', kind: 'ticketType', discordId: '123456789012345678', name: 'Desk' })],
        });

        expect(itemFor(plan, 'desk').action).toBe('forget');
        expect(plannedDeletions(plan)).toEqual([]);
    });
});
