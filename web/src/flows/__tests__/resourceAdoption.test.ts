import { describe, expect, it } from 'vitest';
import type { GuildChannel, ResourceDeclaration } from '../../api/types';
import {
    adoptableChannelOptions,
    canHaveParent,
    declarationForAdoptedChannel,
    declarationForNewResource,
    slugifyResourceName,
    uniqueResourceKey,
} from '../resourceAdoption';

const CHANNELS: GuildChannel[] = [
    { id: '100000000000000001', name: 'announcements' },
    { id: '100000000000000002', name: 'general' },
    { id: '100000000000000003', name: 'Rules & Info' },
];

describe('adoptableChannelOptions', () => {
    it('offers every guild channel when nothing is declared', () => {
        const options = adoptableChannelOptions(CHANNELS, 'textChannel', []);

        expect(options).toEqual([
            { value: '100000000000000001', label: '#announcements' },
            { value: '100000000000000002', label: '#general' },
            { value: '100000000000000003', label: '#Rules & Info' },
        ]);
    });

    it('offers nothing when the guild has no channels', () => {
        expect(adoptableChannelOptions([], 'textChannel', [])).toEqual([]);
    });

    it('does not offer a channel another resource already adopts', () => {
        const declared: ResourceDeclaration[] = [
            {
                key: 'announce',
                kind: 'textChannel',
                defaultName: 'announcements',
                adoptDiscordId: '100000000000000001',
            },
        ];

        const options = adoptableChannelOptions(CHANNELS, 'textChannel', declared);

        expect(options.map((option) => option.value)).toEqual([
            '100000000000000002',
            '100000000000000003',
        ]);
    });

    it("keeps a row's own adoption selectable so editing it does not blank the picker", () => {
        const declared: ResourceDeclaration[] = [
            {
                key: 'announce',
                kind: 'textChannel',
                defaultName: 'announcements',
                adoptDiscordId: '100000000000000001',
            },
        ];

        const options = adoptableChannelOptions(CHANNELS, 'textChannel', declared, 'announce');

        expect(options.map((option) => option.value)).toContain('100000000000000001');
    });

    it('offers nothing for a role, which this list cannot hold', () => {
        expect(adoptableChannelOptions(CHANNELS, 'role', [])).toEqual([]);
    });

    it('offers nothing for a category, because the endpoint returns text channels only', () => {
        // Offering these under "Category" produced a declaration that passed every
        // save-time check and then threw mid-apply in `requireAdoptable`, after
        // earlier resources were already created.
        expect(adoptableChannelOptions(CHANNELS, 'category', [])).toEqual([]);
    });
});

describe('canHaveParent', () => {
    it('is true only for a text channel', () => {
        // Stricter than the server, on purpose: it accepts a category with a parent
        // and then `applyInstallPlan` creates the category with no parent argument,
        // so the value is stored and silently ignored.
        expect(canHaveParent('textChannel')).toBe(true);
        expect(canHaveParent('category')).toBe(false);
        expect(canHaveParent('role')).toBe(false);
    });
});

describe('declarationForAdoptedChannel', () => {
    it('produces a declaration the server accepts, seeded from the channel', () => {
        const declaration = declarationForAdoptedChannel({
            channel: CHANNELS[0]!,
            kind: 'textChannel',
            existing: [],
        });

        expect(declaration).toEqual({
            key: 'announcements',
            kind: 'textChannel',
            defaultName: 'announcements',
            adoptDiscordId: '100000000000000001',
        });
    });

    it('slugs a key the server will accept from a name it would not', () => {
        const declaration = declarationForAdoptedChannel({
            channel: CHANNELS[2]!,
            kind: 'textChannel',
            existing: [],
        });

        // The server's `resourceKeySchema` is /^[a-z0-9]+(-[a-z0-9]+)*$/.
        expect(declaration.key).toBe('rules-info');
        expect(declaration.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        // The *name* keeps the channel's real casing and punctuation — only the key
        // is constrained.
        expect(declaration.defaultName).toBe('Rules & Info');
    });

    it('suffixes a key that collides with one already declared', () => {
        const existing: ResourceDeclaration[] = [
            { key: 'announcements', kind: 'textChannel', defaultName: 'something else' },
        ];

        const declaration = declarationForAdoptedChannel({
            channel: CHANNELS[0]!,
            kind: 'textChannel',
            existing,
        });

        expect(declaration.key).toBe('announcements-2');
    });

    it('carries a parent for a channel', () => {
        const declaration = declarationForAdoptedChannel({
            channel: CHANNELS[1]!,
            kind: 'textChannel',
            existing: [],
            parentKey: 'arrivals',
        });

        expect(declaration.parentKey).toBe('arrivals');
    });

    it('drops a parent on a category, which does not nest', () => {
        const declaration = declarationForAdoptedChannel({
            channel: CHANNELS[1]!,
            kind: 'category',
            existing: [],
            parentKey: 'arrivals',
        });

        expect(declaration.parentKey).toBeUndefined();
    });
});

describe('declarationForNewResource', () => {
    it('does not set an adoption id', () => {
        const declaration = declarationForNewResource({
            name: 'questions',
            kind: 'textChannel',
            existing: [],
        });

        expect(declaration.adoptDiscordId).toBeUndefined();
        expect(declaration).toEqual({
            key: 'questions',
            kind: 'textChannel',
            defaultName: 'questions',
        });
    });

    it('falls back to a kind-shaped name when none is typed', () => {
        expect(declarationForNewResource({ name: '   ', kind: 'textChannel', existing: [] }))
            .toMatchObject({ defaultName: 'new-channel', key: 'new-channel' });
        expect(declarationForNewResource({ name: '', kind: 'role', existing: [] }))
            .toMatchObject({ defaultName: 'new-role' });
    });

    it('drops a parent on a role, which the server rejects one for', () => {
        const declaration = declarationForNewResource({
            name: 'In Approval',
            kind: 'role',
            existing: [],
            parentKey: 'arrivals',
        });

        expect(declaration.parentKey).toBeUndefined();
    });

    it('drops a parent on a category, which apply would ignore', () => {
        const declaration = declarationForNewResource({
            name: 'Arrivals',
            kind: 'category',
            existing: [],
            parentKey: 'somewhere',
        });

        expect(declaration.parentKey).toBeUndefined();
    });

    it('keeps a parent on a text channel', () => {
        const declaration = declarationForNewResource({
            name: 'welcome',
            kind: 'textChannel',
            existing: [],
            parentKey: 'arrivals',
        });

        expect(declaration.parentKey).toBe('arrivals');
    });
});

describe('uniqueResourceKey', () => {
    it('keeps counting past a taken suffix', () => {
        const existing: ResourceDeclaration[] = [
            { key: 'welcome', kind: 'textChannel', defaultName: 'welcome' },
            { key: 'welcome-2', kind: 'textChannel', defaultName: 'welcome' },
        ];

        expect(uniqueResourceKey('welcome', existing)).toBe('welcome-3');
    });

    it('never returns an empty key, which the server rejects', () => {
        // A channel named only in punctuation or non-Latin script slugs to nothing.
        expect(slugifyResourceName('!!!')).toBe('');
        expect(uniqueResourceKey(slugifyResourceName('!!!'), [])).toBe('resource');
    });
});
