import { describe, expect, it } from 'vitest';
import type { TicketingConfigView } from '../../api/types';
import { DEFAULT_TICKET_FILTER, toListFilter, typeFilterOptions } from '../ticketFilters';

describe('DEFAULT_TICKET_FILTER', () => {
    it('opens on open tickets only', () => {
        // A list that opens on the guild's whole history buries the handful anybody can
        // act on under everything already dealt with.
        expect(DEFAULT_TICKET_FILTER.status).toBe('open');
        expect(DEFAULT_TICKET_FILTER.unclaimedOnly).toBe(false);
    });
});

describe('toListFilter', () => {
    it('drops status "all" rather than sending it, which the route would reject', () => {
        // The route validates `status` against the three real statuses, correctly — `all`
        // is the absence of a filter, not a fourth status.
        expect(toListFilter({ ...DEFAULT_TICKET_FILTER, status: 'all' }).status).toBeUndefined();
    });

    it('sends a real status through', () => {
        expect(toListFilter({ ...DEFAULT_TICKET_FILTER, status: 'closed' }).status).toBe('closed');
    });

    it('drops a blank search rather than sending an empty query', () => {
        expect(toListFilter({ ...DEFAULT_TICKET_FILTER, search: '   ' }).search).toBeUndefined();
    });

    it('trims a search, because a trailing space is not part of a name', () => {
        expect(toListFilter({ ...DEFAULT_TICKET_FILTER, search: '  kitten ' }).search).toBe('kitten');
    });

    it('omits unclaimedOnly when it is off', () => {
        expect(toListFilter(DEFAULT_TICKET_FILTER).unclaimedOnly).toBeUndefined();
    });
});

describe('typeFilterOptions', () => {
    const config = {
        types: [
            { type: 'support', label: 'Support', nameTemplate: 'S', permissions: {}, autoClaimOnOpen: true },
            { type: 'verification', label: 'Verification', nameTemplate: 'V', permissions: {}, autoClaimOnOpen: false },
        ],
    } as unknown as TicketingConfigView;

    it('leads with a selectable "all", so a chosen filter can be undone', () => {
        const options = typeFilterOptions(config);

        expect(options[0]).toEqual({ value: '', label: 'All types' });
    });

    it('labels each type the way an operator named it, not by its key', () => {
        expect(typeFilterOptions(config).slice(1)).toEqual([
            { value: 'support', label: 'Support' },
            { value: 'verification', label: 'Verification' },
        ]);
    });

    it('still offers "all" for a guild with no config loaded yet', () => {
        expect(typeFilterOptions(null)).toEqual([{ value: '', label: 'All types' }]);
    });
});
