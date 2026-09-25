import { describe, expect, it } from 'vitest';
import type { GuildChannel, GuildRole } from '../../api/types';
import type { ExistingChannelOption } from '../resourceAdoption';
import {
    collidableNamesFor,
    disambiguateOptions,
    nameCollidesWithExisting,
    rankSuggestions,
} from '../resourceNameSuggestions';

function option(value: string, label: string): ExistingChannelOption {
    return { value, label };
}

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

function role(id: string, name: string): GuildRole {
    return { id, name, color: 0, position: 1 };
}

describe('rankSuggestions', () => {
    it('puts an exact match above a prefix match above a substring match', () => {
        const ranked = rankSuggestions(
            [
                option('1', '#general-chat'),
                option('2', '#the-general-rules'),
                option('3', '#general'),
            ],
            'general'
        );

        expect(ranked.map((entry) => [entry.option.value, entry.rank])).toEqual([
            ['3', 'exact'],
            ['1', 'prefix'],
            ['2', 'substring'],
        ]);
    });

    it('drops options that do not match at all', () => {
        const ranked = rankSuggestions([option('1', '#welcome'), option('2', '#rules')], 'wel');

        expect(ranked.map((entry) => entry.option.value)).toEqual(['1']);
    });

    /*
     * The decoration is the operator's problem only if we make it one. They type
     * `welcome`, not `#welcome`, so ranking against the raw label would demote every
     * channel to `substring` and the exact-match tier would be unreachable for channels
     * entirely — which is the tier carrying the save-blocking consequence.
     */
    it('ignores the # a channel label carries', () => {
        const ranked = rankSuggestions([option('1', '#welcome')], 'welcome');

        expect(ranked[0]!.rank).toBe('exact');
    });

    it('ignores the @ a role label carries', () => {
        const ranked = rankSuggestions([option('1', '@Verified')], 'verified');

        expect(ranked[0]!.rank).toBe('exact');
    });

    it('ignores the category qualifier when ranking', () => {
        // `#general · in Support` is still exactly `general`. Ranking the whole label
        // would sort a qualified channel below an unqualified one of the same name,
        // for a reason the operator cannot see.
        const ranked = rankSuggestions([option('1', '#general · in Support')], 'general');

        expect(ranked[0]!.rank).toBe('exact');
    });

    it('matches without regard to case', () => {
        expect(rankSuggestions([option('1', '@Verified')], 'VERIFIED')[0]!.rank).toBe('exact');
    });

    it('ignores surrounding whitespace, as the server does', () => {
        expect(rankSuggestions([option('1', '#welcome')], '  welcome  ')[0]!.rank).toBe('exact');
    });

    it('returns everything for an empty query', () => {
        // A freshly opened row has typed nothing, and showing an empty list would hide
        // that adoption is available at all — the discoverability problem the separate
        // picker had.
        const options = [option('1', '#welcome'), option('2', '#rules')];

        expect(rankSuggestions(options, '').map((entry) => entry.option.value)).toEqual([
            '1',
            '2',
        ]);
    });

    it('keeps the incoming order between equally good matches', () => {
        // Two channels named `general` in different categories are both exact. The
        // incoming order is the guild's own name sort; re-sorting by label would
        // reorder them for a reason nothing on screen explains.
        const ranked = rankSuggestions(
            [option('1', '#general · in Support'), option('2', '#general · in Lounge')],
            'general'
        );

        expect(ranked.map((entry) => entry.option.value)).toEqual(['1', '2']);
    });

    it('offers nothing when there is nothing to offer', () => {
        expect(rankSuggestions([], 'welcome')).toEqual([]);
    });

    it('still ranks a disambiguated label by its real name', () => {
        // The ` (id)` suffix is applied upstream, so ranking sees it. Stripping only the
        // prefix and the parent would leave `@Verified (r1)` unable to match `verified`
        // exactly — demoting the tier that carries the save-blocking consequence.
        const ranked = rankSuggestions(
            disambiguateOptions([option('r1', '@Verified'), option('r2', '@Verified')]),
            'verified'
        );

        expect(ranked.map((entry) => entry.rank)).toEqual(['exact', 'exact']);
    });
});

/**
 * Discord permits duplicate names and the decoration does not always separate them.
 *
 * Two rows reading `@Verified` is the original "which #general did I pick?" problem one
 * layer up — and worse here, because the operator is choosing rather than reading. It is
 * also what made the first cut of this control **crash**: Mantine throws during render
 * on a repeated option value, and that cut keyed its options by label.
 */
describe('disambiguateOptions', () => {
    it('tells two identically-labelled roles apart by id', () => {
        expect(
            disambiguateOptions([option('r1', '@Verified'), option('r2', '@Verified')]).map(
                (entry) => entry.label
            )
        ).toEqual(['@Verified (r1)', '@Verified (r2)']);
    });

    it('tells two top-level channels of one name apart', () => {
        // A parent would have done it, and for channels in *different* categories it
        // does. Neither of these has one.
        expect(
            disambiguateOptions([option('1', '#general'), option('2', '#general')]).map(
                (entry) => entry.label
            )
        ).toEqual(['#general (1)', '#general (2)']);
    });

    it('leaves an unambiguous label alone', () => {
        // The common case carries no noise. Suffixing every row would be the chip
        // vocabulary's mistake — a marker on most rows carries nothing.
        expect(
            disambiguateOptions([
                option('1', '#general · in Support'),
                option('2', '#general · in Lounge'),
            ]).map((entry) => entry.label)
        ).toEqual(['#general · in Support', '#general · in Lounge']);
    });

    it('never touches the id it would bind', () => {
        // The suffix is display only. Binding goes by `value`, which is what makes
        // picking the *second* duplicate bind the second object.
        expect(
            disambiguateOptions([option('r1', '@Verified'), option('r2', '@Verified')]).map(
                (entry) => entry.value
            )
        ).toEqual(['r1', 'r2']);
    });

    /*
     * Why this runs over the whole list rather than the ranked-and-capped window.
     *
     * Whether a label is ambiguous is a fact about the *guild*. Deciding it from the
     * visible slice would call a name unique because its twin fell outside the cut — and
     * then the committed row and the dropdown would disagree about what to call it.
     */
    it('decides ambiguity over everything it is given, not a visible window', () => {
        const many = Array.from({ length: 30 }, (_unused, index) =>
            option(`id-${index}`, index === 0 || index === 29 ? '@Verified' : `@Role ${index}`)
        );

        const labels = disambiguateOptions(many).map((entry) => entry.label);

        expect(labels[0]).toBe('@Verified (id-0)');
        expect(labels[29]).toBe('@Verified (id-29)');
    });
});

/**
 * The browser's copy of an install-time refusal.
 *
 * `installPlan.ts` blocks an item whose declared name matches an existing object when
 * nothing is adopted. That blocker is right; what was wrong is that the operator met it
 * after authoring a whole journey and pressing install, named against a resource key
 * rather than the row they typed into.
 */
describe('nameCollidesWithExisting', () => {
    it('reports a name that already belongs to something', () => {
        expect(
            nameCollidesWithExisting({
                declaredName: 'welcome',
                adoptDiscordId: undefined,
                guildNames: ['welcome', 'rules'],
            })
        ).toBe(true);
    });

    it('says nothing about a name nothing else has', () => {
        expect(
            nameCollidesWithExisting({
                declaredName: 'arrivals',
                adoptDiscordId: undefined,
                guildNames: ['welcome', 'rules'],
            })
        ).toBe(false);
    });

    it('is silent once the row adopts something', () => {
        // Adopting resolves the question by definition — the name *is* the adopted
        // object's, and matching it is the point rather than a collision.
        expect(
            nameCollidesWithExisting({
                declaredName: 'welcome',
                adoptDiscordId: '100000000000000001',
                guildNames: ['welcome'],
            })
        ).toBe(false);
    });

    it('is silent on an empty name, which has its own chip', () => {
        expect(
            nameCollidesWithExisting({
                declaredName: '   ',
                adoptDiscordId: undefined,
                guildNames: ['welcome'],
            })
        ).toBe(false);
    });

    it('compares the way the server does, ignoring case and surrounding space', () => {
        // `findByName` is `trim().toLowerCase()` equality. Comparing differently means
        // either a chip the server disagrees with or — worse — silence on a name the
        // install will refuse.
        expect(
            nameCollidesWithExisting({
                declaredName: '  WELCOME ',
                adoptDiscordId: undefined,
                guildNames: ['welcome'],
            })
        ).toBe(true);
    });
});

describe('collidableNamesFor', () => {
    const CHANNELS = [
        textChannel('1', 'welcome'),
        textChannel('2', 'rules'),
        category('cat1', 'Arrivals'),
    ];
    const ROLES = [role('r1', 'Verified')];

    it('gives a text-channel declaration the text channels', () => {
        expect(collidableNamesFor({ kind: 'textChannel', channels: CHANNELS, roles: ROLES }))
            .toEqual(['welcome', 'rules']);
    });

    it('gives a category declaration the categories', () => {
        expect(collidableNamesFor({ kind: 'category', channels: CHANNELS, roles: ROLES }))
            .toEqual(['Arrivals']);
    });

    it('gives a role declaration the roles', () => {
        expect(collidableNamesFor({ kind: 'role', channels: CHANNELS, roles: ROLES }))
            .toEqual(['Verified']);
    });

    it('does not let a category and a channel collide with each other', () => {
        // Discord permits a category and a channel sharing a name, and `findByName`
        // filters on type before comparing — so a chip that flagged this would block a
        // save the install would have accepted.
        const channels = [textChannel('1', 'Arrivals'), category('cat1', 'Arrivals')];

        expect(
            nameCollidesWithExisting({
                declaredName: 'Arrivals',
                adoptDiscordId: undefined,
                guildNames: collidableNamesFor({ kind: 'role', channels, roles: [] }),
            })
        ).toBe(false);
    });

    /*
     * The bug this signature exists to prevent.
     *
     * The obvious implementation passes the row's adopt *options*, which have already
     * had ids other rows claim removed. `findByName` on the server has no such
     * exclusion — it searches the raw guild cache — so a `#welcome` adopted by another
     * row is absent from this row's options while still being exactly what blocks this
     * row's install.
     */
    it('still collides with a channel another row has already adopted', () => {
        const channels = [textChannel('1', 'welcome')];

        expect(
            nameCollidesWithExisting({
                declaredName: 'welcome',
                adoptDiscordId: undefined,
                guildNames: collidableNamesFor({ kind: 'textChannel', channels, roles: [] }),
            })
        ).toBe(true);
    });
});
