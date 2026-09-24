import { describe, expect, it } from 'vitest';
import { joinWithAnd } from '../nameLists';

/**
 * The separator rule, pinned where it can fail.
 *
 * This is copy that names the resources and flows an operator is about to affect, so
 * the failure mode that matters is not a crash — it is a list that silently drops or
 * mispunctuates a name and still reads like a sentence.
 */
describe('joinWithAnd', () => {
    it('is empty for no names', () => {
        expect(joinWithAnd([])).toBe('');
    });

    it('leaves a single name alone', () => {
        expect(joinWithAnd(['Welcome & intro'])).toBe('Welcome & intro');
    });

    it('joins two names with "and", never a comma', () => {
        expect(joinWithAnd(['Welcome', 'Rules gate'])).toBe('Welcome and Rules gate');
    });

    it('commas every name but the last, which takes the "and"', () => {
        expect(joinWithAnd(['Welcome', 'Rules gate', 'Tickets'])).toBe(
            'Welcome, Rules gate and Tickets'
        );
    });

    /** The off-by-one that reads fine and loses a name. */
    it('keeps every name it was given', () => {
        const names = ['One', 'Two', 'Three', 'Four'];

        for (const name of names) {
            expect(joinWithAnd(names)).toContain(name);
        }
    });
});
