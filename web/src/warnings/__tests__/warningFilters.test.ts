import { describe, expect, it } from 'vitest';
import { DEFAULT_WARNING_FILTER, filtersHideWarnings, toListFilter } from '../warningFilters';

describe('toListFilter', () => {
    it('opens on active warnings, with nothing else asked', () => {
        expect(toListFilter(DEFAULT_WARNING_FILTER)).toEqual({ status: 'active', userId: undefined, search: undefined });
    });

    it('sends "all" as no status, which the route reads as every status', () => {
        expect(toListFilter({ ...DEFAULT_WARNING_FILTER, status: 'all' }).status).toBeUndefined();
    });

    it("sends the member's id, never the name the chip shows", () => {
        const query = toListFilter({ ...DEFAULT_WARNING_FILTER, member: { id: '400000000000000004', name: 'Kitten' } });

        expect(query.userId).toBe('400000000000000004');
        expect(Object.values(query)).not.toContain('Kitten');
    });

    it('trims the search, and sends a blank one as none', () => {
        expect(toListFilter({ ...DEFAULT_WARNING_FILTER, search: '  rope  ' }).search).toBe('rope');
        expect(toListFilter({ ...DEFAULT_WARNING_FILTER, search: '   ' }).search).toBeUndefined();
    });
});

describe('filtersHideWarnings', () => {
    it('is false for any status alone, which the counts already account for', () => {
        expect(filtersHideWarnings(DEFAULT_WARNING_FILTER)).toBe(false);
        expect(filtersHideWarnings({ ...DEFAULT_WARNING_FILTER, status: 'released' })).toBe(false);
        expect(filtersHideWarnings({ ...DEFAULT_WARNING_FILTER, status: 'all' })).toBe(false);
        expect(filtersHideWarnings({ ...DEFAULT_WARNING_FILTER, search: '  ' })).toBe(false);
    });

    it('is true once a member or a search narrows it', () => {
        expect(filtersHideWarnings({ ...DEFAULT_WARNING_FILTER, member: { id: '1', name: 'x' } })).toBe(true);
        expect(filtersHideWarnings({ ...DEFAULT_WARNING_FILTER, search: 'brat' })).toBe(true);
    });
});
