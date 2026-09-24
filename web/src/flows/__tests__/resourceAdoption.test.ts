import { describe, expect, it } from 'vitest';
import type { GuildChannel, ResourceDeclaration } from '../../api/types';
import {
    adoptableChannelOptions,
    canAdoptFromChannelList,
    canHaveParent,
    channelOptionLabel,
    declarationForAdoptedChannel,
    declarationForNewResource,
    postableChannels,
    slugifyResourceName,
    uniqueResourceKey,
} from '../resourceAdoption';

function textChannel(id: string, name: string, parentName: string | null = null): GuildChannel {
    return {
        id,
        name,
        type: 'text',
        parentId: parentName ? `parent-of-${id}` : null,
        parentName,
    };
}

function category(id: string, name: string): GuildChannel {
    return { id, name, type: 'category', parentId: null, parentName: null };
}

const CHANNELS: GuildChannel[] = [
    textChannel('100000000000000001', 'announcements'),
    textChannel('100000000000000002', 'general'),
    textChannel('100000000000000003', 'Rules & Info'),
];

/**
 * The predicate every "somewhere to post" picker runs on.
 *
 * It exists because the alternative shipped once: `ChannelPickerControl` mapped the
 * raw channel list straight into post targets under a comment claiming categories were
 * excluded, which was true only because the *server* filtered them out — two files away
 * and across the wire. The endpoint now sends categories so they can be adopted, which
 * would have turned that comment into a lie and offered a category as a place to send a
 * message. A config the executor cannot use, failing in a live guild after publish.
 */
describe('postableChannels', () => {
    it('drops categories', () => {
        const kept = postableChannels([
            textChannel('1', 'general'),
            category('cat1', 'Support'),
            textChannel('2', 'random'),
        ]);

        expect(kept.map((channel) => channel.id)).toEqual(['1', '2']);
    });

    it('keeps announcement channels, which a flow can post in', () => {
        const announcement: GuildChannel = {
            id: 'a1',
            name: 'news',
            type: 'announcement',
            parentId: null,
            parentName: null,
        };

        expect(postableChannels([announcement])).toHaveLength(1);
    });
});

describe('channelOptionLabel', () => {
    it('gives a channel a hash and a category none', () => {
        // The prefix is most of what made a category read as a channel in the picker
        // that should never have offered it.
        expect(channelOptionLabel(textChannel('1', 'general'))).toBe('#general');
        expect(channelOptionLabel(category('cat1', 'Support'))).toBe('Support');
    });

    it('qualifies by parent when there is one', () => {
        expect(channelOptionLabel(textChannel('1', 'general', 'Support'))).toBe(
            '#general · in Support'
        );
    });
});

describe('canAdoptFromChannelList', () => {
    it('admits categories now that the directory carries them', () => {
        expect(canAdoptFromChannelList('category')).toBe(true);
        expect(canAdoptFromChannelList('textChannel')).toBe(true);
    });

    it('still refuses roles, which come from a different endpoint', () => {
        expect(canAdoptFromChannelList('role')).toBe(false);
    });
});

describe('adoptableChannelOptions', () => {
    it('offers every guild channel when nothing is declared', () => {
        const options = adoptableChannelOptions(CHANNELS, 'textChannel', []);

        expect(options).toEqual([
            { value: '100000000000000001', label: '#announcements' },
            { value: '100000000000000002', label: '#general' },
            { value: '100000000000000003', label: '#Rules & Info' },
        ]);
    });

    /*
     * ## Telling two channels of the same name apart
     *
     * The motivating case for widening `GET /channels`. Two channels called `general`
     * in different categories rendered as two identical `#general` rows: the operator
     * picked one and found out later which. Nothing in the picker could distinguish
     * them, because the endpoint sent `{id, name}` and nothing else.
     */
    it('names the parent category so two channels of one name differ', () => {
        const options = adoptableChannelOptions(
            [
                textChannel('1', 'general', 'Support'),
                textChannel('2', 'general', 'Lounge'),
            ],
            'textChannel',
            []
        );

        expect(options.map((option) => option.label)).toEqual([
            '#general · in Support',
            '#general · in Lounge',
        ]);
    });

    it('leaves a top-level channel unqualified', () => {
        // Nothing to disambiguate against, and "· in nothing" is noise on the common
        // case.
        const options = adoptableChannelOptions([textChannel('1', 'general')], 'textChannel', []);

        expect(options[0]!.label).toBe('#general');
    });

    it('offers categories to a category declaration, and no channels', () => {
        // Previously impossible: the endpoint sent text channels only, so a category
        // declaration was offered `#general` under the label "Which category" — a
        // declaration that passed validation and failed mid-apply in `requireAdoptable`.
        const options = adoptableChannelOptions(
            [textChannel('1', 'general'), category('cat1', 'Support')],
            'category',
            []
        );

        expect(options).toEqual([{ value: 'cat1', label: 'Support' }]);
    });

    it('never offers a category to a text-channel declaration', () => {
        const options = adoptableChannelOptions(
            [textChannel('1', 'general'), category('cat1', 'Support')],
            'textChannel',
            []
        );

        expect(options).toEqual([{ value: '1', label: '#general' }]);
    });

    it('offers an announcement channel where a text channel is wanted', () => {
        // A flow can post in one, and a declaration saying "text channel" is naming
        // somewhere to post rather than a specific Discord product.
        const announcement: GuildChannel = {
            id: 'a1',
            name: 'news',
            type: 'announcement',
            parentId: null,
            parentName: null,
        };

        expect(adoptableChannelOptions([announcement], 'textChannel', [])).toEqual([
            { value: 'a1', label: '#news' },
        ]);
    });

    it('offers nothing to a role declaration', () => {
        // Roles come from a different endpoint this module is never handed, so the
        // honest answer is still that they cannot be picked here.
        expect(adoptableChannelOptions(CHANNELS, 'role', [])).toEqual([]);
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
