import { describe, expect, it } from 'vitest';
import { MEMBER_NICKNAME_HISTORY_CAP } from '../../data/memberNamesSchema';
import { mergeNicknames } from '../mergeNicknames';

describe('mergeNicknames', () => {
    it('puts a new nickname first', () => {
        expect(mergeNicknames(['Brat', 'Kitten'], 'Pet')).toEqual(['Pet', 'Brat', 'Kitten']);
    });

    it('moves a nickname seen before to the front instead of listing it twice', () => {
        expect(mergeNicknames(['Brat', 'Kitten', 'Pet'], 'Kitten')).toEqual(['Kitten', 'Brat', 'Pet']);
    });

    it('adds nothing for no nickname', () => {
        expect(mergeNicknames(['Brat'], null)).toEqual(['Brat']);
        expect(mergeNicknames(['Brat'], '')).toEqual(['Brat']);
    });

    it('keeps a nickname differing only in case as its own', () => {
        expect(mergeNicknames(['brat'], 'Brat')).toEqual(['Brat', 'brat']);
    });

    it(`drops the oldest past ${MEMBER_NICKNAME_HISTORY_CAP}`, () => {
        const full = Array.from({ length: MEMBER_NICKNAME_HISTORY_CAP }, (_unused, index) => `nick-${index}`);

        const merged = mergeNicknames(full, 'newest');

        expect(merged).toHaveLength(MEMBER_NICKNAME_HISTORY_CAP);
        expect(merged[0]).toBe('newest');
        expect(merged).not.toContain(`nick-${MEMBER_NICKNAME_HISTORY_CAP - 1}`);
    });
});
