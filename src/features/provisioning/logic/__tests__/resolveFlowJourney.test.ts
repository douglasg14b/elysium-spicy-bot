import { describe, expect, it, vi } from 'vitest';
import type { JourneyEntity } from '../../data/journeysSchema';
import { resolveFlowJourney } from '../resolveFlowJourney';

/**
 * Which journey a flow installs.
 *
 * The behaviour that matters is the precedence between the two rules — the link row
 * and the temporary key convention — because getting it backwards is silent: a flow
 * attached to a shared journey would resolve to a journey keyed with its own id and
 * install the wrong resources, with nothing failing.
 *
 * Driven through injected repos rather than mocked modules. Both are pure lookups, so
 * a stub is the whole of their behaviour here, and the resolver itself runs for real.
 */

const GUILD = 'guild-1';
const FLOW_ID = '11111111-2222-3333-4444-555555555555';

function journey(journeyKey: string, createdForFlowId: string | null = null): JourneyEntity {
    return {
        id: 1,
        journeyKey,
        guildId: GUILD,
        name: `Journey ${journeyKey}`,
        description: null,
        resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
        createdForFlowId,
        createdAt: new Date('2026-09-21T10:00:00Z'),
        updatedAt: new Date('2026-09-21T10:00:00Z'),
    } as unknown as JourneyEntity;
}

/** Repos holding the given links and journeys, keyed the way the real tables are. */
function deps(input: {
    links?: Record<string, string>;
    journeys?: Record<string, JourneyEntity>;
}) {
    return {
        links: {
            getJourneyKeyForFlow: vi.fn(async (_guildId: string, flowId: string) =>
                input.links?.[flowId] ?? null
            ),
        },
        journeys: {
            getByKey: vi.fn(async (_guildId: string, journeyKey: string) =>
                input.journeys?.[journeyKey] ?? null
            ),
        },
    };
}

describe('resolveFlowJourney', () => {
    it('resolves through the link row, to a journey keyed nothing like the flow', async () => {
        const resolved = await resolveFlowJourney(
            GUILD,
            FLOW_ID,
            deps({
                links: { [FLOW_ID]: 'onboarding' },
                journeys: { onboarding: journey('onboarding') },
            })
        );

        // The point of the table: the key is not the flow id, and it resolves anyway.
        expect(resolved?.journey.journeyKey).toBe('onboarding');
        expect(resolved?.attached).toBe(true);
    });

    it('falls back to the implicit key when a flow has no link row', async () => {
        const resolved = await resolveFlowJourney(
            GUILD,
            FLOW_ID,
            deps({ journeys: { [FLOW_ID]: journey(FLOW_ID, FLOW_ID) } })
        );

        // Every flow that predates the link table still works, which is what makes
        // slice A and B invisible.
        expect(resolved?.journey.journeyKey).toBe(FLOW_ID);
        // Flagged as inferred, not recorded — the install ownership check reads this.
        expect(resolved?.attached).toBe(false);
    });

    it('prefers the link row over a journey that happens to be keyed like the flow', async () => {
        const resolved = await resolveFlowJourney(
            GUILD,
            FLOW_ID,
            deps({
                links: { [FLOW_ID]: 'onboarding' },
                journeys: {
                    onboarding: journey('onboarding'),
                    [FLOW_ID]: journey(FLOW_ID, FLOW_ID),
                },
            })
        );

        // Both rules match here. The attachment is the one an operator wrote down.
        expect(resolved?.journey.journeyKey).toBe('onboarding');
    });

    it('resolves to nothing when a link names a journey that no longer exists', async () => {
        const resolved = await resolveFlowJourney(
            GUILD,
            FLOW_ID,
            deps({
                links: { [FLOW_ID]: 'deleted-journey' },
                journeys: { [FLOW_ID]: journey(FLOW_ID, FLOW_ID) },
            })
        );

        // Deliberately not the fallback. Substituting a different journey because the
        // attached one vanished would install resources nobody attached.
        expect(resolved).toBeNull();
    });

    it('resolves to nothing for a flow that declares nothing and is attached to nothing', async () => {
        expect(await resolveFlowJourney(GUILD, FLOW_ID, deps({}))).toBeNull();
    });
});
