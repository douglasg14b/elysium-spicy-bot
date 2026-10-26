import { describe, expect, it } from 'vitest';
import { flowIdsInJourney } from '../journeyMembership';

/**
 * The one membership rule: a flow is in journey J only when `resolveFlowJourney` would say J.
 * Its link row decides; only a flow with no link row falls back to the journey keyed on its id.
 */
describe('flowIdsInJourney', () => {
    it('takes the flows linked to the journey', () => {
        const members = flowIdsInJourney({
            journeyKey: 'onboarding',
            links: [
                { flowId: 'flow-1', journeyKey: 'onboarding' },
                { flowId: 'flow-2', journeyKey: 'onboarding' },
                { flowId: 'flow-3', journeyKey: 'tickets' },
            ],
            guildFlowIds: ['flow-1', 'flow-2', 'flow-3'],
        });

        expect([...members]).toEqual(['flow-1', 'flow-2']);
    });

    it('admits a flow with no link row to the journey keyed on its id', () => {
        const members = flowIdsInJourney({
            journeyKey: 'flow-legacy',
            links: [],
            guildFlowIds: ['flow-legacy', 'flow-other'],
        });

        expect([...members]).toEqual(['flow-legacy']);
    });

    /**
     * The case the old install rule got wrong: it admitted a flow by its id alone, so a flow
     * grouped away still counted as its old journey's — its ids written in, its buttons
     * answering for it.
     */
    it('leaves out a flow grouped away from the journey keyed on its id', () => {
        const members = flowIdsInJourney({
            journeyKey: 'flow-legacy',
            links: [{ flowId: 'flow-legacy', journeyKey: 'the-group' }],
            guildFlowIds: ['flow-legacy'],
        });

        expect([...members]).toEqual([]);
    });

    it('does not invent a flow from a key that matches nothing in the guild', () => {
        const members = flowIdsInJourney({
            journeyKey: 'flow-deleted',
            links: [{ flowId: 'flow-deleted', journeyKey: 'flow-deleted' }],
            guildFlowIds: ['flow-1'],
        });

        expect([...members]).toEqual([]);
    });

    it('counts a flow both linked and key-matched once', () => {
        const members = flowIdsInJourney({
            journeyKey: 'flow-1',
            links: [{ flowId: 'flow-1', journeyKey: 'flow-1' }],
            guildFlowIds: ['flow-1'],
        });

        expect([...members]).toEqual(['flow-1']);
    });
});
