import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import { describeOrphan, findOrphanedBindings } from '../orphanedBindings';
import type { JourneyDeclaration, ResourceKind } from '../resourceDeclaration';

/**
 * An orphan is a resource the journey installed and no longer declares. The object and
 * its row both survive an edit deliberately — deleting a live channel as a side effect
 * of removing a panel row is the behaviour the repos explicitly refuse — so the result
 * is a channel nothing on any screen mentions until this reports it.
 */

let nextId = 1;

function binding(overrides: Partial<ResourceBindingEntity> = {}): ResourceBindingEntity {
    return {
        id: nextId++,
        guildId: 'guild-1',
        journeyKey: 'journey-1',
        resourceKey: 'welcome-channel',
        kind: 'textChannel',
        state: 'created',
        discordId: 'channel-1',
        name: 'welcome',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as ResourceBindingEntity;
}

function journey(keys: readonly string[]): JourneyDeclaration {
    return {
        journeyKey: 'journey-1',
        name: 'Journey One',
        resources: keys.map((key) => ({
            key,
            kind: 'textChannel' as ResourceKind,
            defaultName: key,
        })),
    } as JourneyDeclaration;
}

const present = () => true;
const absent = () => false;

describe('findOrphanedBindings', () => {
    it('finds a binding the journey no longer declares', () => {
        const orphans = findOrphanedBindings({
            journey: journey(['rules-channel']),
            bindings: [binding({ resourceKey: 'welcome-channel' })],
            existsInGuild: present,
        });

        expect(orphans).toHaveLength(1);
        expect(orphans[0]).toMatchObject({
            resourceKey: 'welcome-channel',
            stillInGuild: true,
            mayDelete: true,
        });
    });

    it('reports nothing when every binding is still declared', () => {
        const orphans = findOrphanedBindings({
            journey: journey(['welcome-channel']),
            bindings: [binding()],
            existsInGuild: present,
        });

        expect(orphans).toEqual([]);
    });

    it('marks an orphan whose object is already gone', () => {
        const orphans = findOrphanedBindings({
            journey: journey([]),
            bindings: [binding()],
            existsInGuild: absent,
        });

        expect(orphans[0]?.stillInGuild).toBe(false);
    });

    it('treats an intended row as not in the guild, whatever the predicate says', () => {
        const orphans = findOrphanedBindings({
            journey: journey([]),
            // An `intended` row records an install that never reached Discord. Its
            // discordId, if any, names nothing.
            bindings: [binding({ state: 'intended' })],
            existsInGuild: present,
        });

        expect(orphans[0]?.stillInGuild).toBe(false);
    });

    /**
     * The adoption promise does not lapse because the declaration referencing it was
     * removed. The row may be forgotten; the object may not be touched.
     */
    it('refuses to allow deleting an adopted orphan', () => {
        const orphans = findOrphanedBindings({
            journey: journey([]),
            bindings: [binding({ state: 'adopted' })],
            existsInGuild: present,
        });

        expect(orphans[0]).toMatchObject({ stillInGuild: true, mayDelete: false });
    });

    it('finds several orphans at once', () => {
        const orphans = findOrphanedBindings({
            journey: journey(['kept']),
            bindings: [
                binding({ resourceKey: 'kept' }),
                binding({ resourceKey: 'dropped-one', discordId: 'channel-2' }),
                binding({ resourceKey: 'dropped-two', discordId: 'channel-3', kind: 'role' }),
            ],
            existsInGuild: present,
        });

        expect(orphans.map((orphan) => orphan.resourceKey)).toEqual([
            'dropped-one',
            'dropped-two',
        ]);
    });
});

describe('describeOrphan', () => {
    it('leads with the fact that explains the rest', () => {
        const [orphan] = findOrphanedBindings({
            journey: journey([]),
            bindings: [binding()],
            existsInGuild: present,
        });

        expect(describeOrphan(orphan!)).toMatch(/no longer declared/);
        expect(describeOrphan(orphan!)).toMatch(/still in your server/);
    });

    it('says an adopted orphan will be left alone', () => {
        const [orphan] = findOrphanedBindings({
            journey: journey([]),
            bindings: [binding({ state: 'adopted' })],
            existsInGuild: present,
        });

        expect(describeOrphan(orphan!)).toMatch(/left exactly where it is/);
    });

    it('says only the record remains when the object is gone', () => {
        const [orphan] = findOrphanedBindings({
            journey: journey([]),
            bindings: [binding()],
            existsInGuild: absent,
        });

        expect(describeOrphan(orphan!)).toMatch(/already gone/);
    });
});
