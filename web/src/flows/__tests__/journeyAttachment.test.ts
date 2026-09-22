import { describe, expect, it } from 'vitest';
import type { JourneySummary } from '../../api/types';
import {
    attachableJourneys,
    deleteBlockedReason,
    describeAttachIntent,
    describeDetachIntent,
    slugifyJourneyName,
    uniqueJourneyKey,
} from '../journeyAttachment';

/**
 * The attach/detach rules that are wrong *quietly*.
 *
 * `web/` has no jsdom and no React Testing Library, so the components are untestable
 * here by construction — which is precisely why these decisions live outside them. The
 * two that matter are copy: an attach described as an addition when it is a move, and a
 * detach read as an uninstall. Neither fails loudly; both send the operator looking for
 * something that is not where they were told it would be.
 */

function journey(overrides: Partial<JourneySummary> = {}): JourneySummary {
    return {
        journeyKey: 'onboarding',
        name: 'Onboarding',
        description: null,
        resourceCount: 3,
        attachedFlows: [],
        createdAt: '2026-09-19T10:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
        ...overrides,
    };
}

describe('slugifyJourneyName', () => {
    it('produces a key the server\'s resource-key pattern accepts', () => {
        expect(slugifyJourneyName('Onboarding & Rules!')).toBe('onboarding-rules');
    });

    it('caps at 64 characters, matching the server', () => {
        expect(slugifyJourneyName('a'.repeat(200))).toHaveLength(64);
    });

    it('slugs a name of only punctuation to nothing rather than to a hyphen', () => {
        // A leading or trailing hyphen fails the server's pattern; `uniqueJourneyKey`
        // is what turns the empty result into something sendable.
        expect(slugifyJourneyName('!!!')).toBe('');
    });
});

describe('uniqueJourneyKey', () => {
    it('keeps the desired key when nothing has taken it', () => {
        expect(uniqueJourneyKey('onboarding', ['rules'])).toBe('onboarding');
    });

    it('suffixes past every collision rather than stopping at the first', () => {
        expect(uniqueJourneyKey('onboarding', ['onboarding', 'onboarding-2'])).toBe(
            'onboarding-3'
        );
    });

    it('falls back to a usable key when the name slugged to nothing', () => {
        // The server's `min(1)` refuses an empty key, and a 400 on "create" for a name
        // the operator typed is a failure they cannot act on.
        expect(uniqueJourneyKey('', [])).toBe('journey');
    });
});

describe('deleteBlockedReason', () => {
    it('is undefined when nothing is attached, so the delete is offered', () => {
        expect(deleteBlockedReason(journey())).toBeUndefined();
    });

    it('names the single attached flow', () => {
        const reason = deleteBlockedReason(
            journey({ attachedFlows: [{ flowId: 'a', name: 'Welcome wagon' }] })
        );

        expect(reason).toContain('Welcome wagon');
        expect(reason).toContain('Detach it first');
    });

    it('names every attached flow rather than counting them alone', () => {
        // A count tells an operator the size of a problem they then have to go and find.
        const reason = deleteBlockedReason(
            journey({
                attachedFlows: [
                    { flowId: 'a', name: 'Welcome wagon' },
                    { flowId: 'b', name: 'Age check' },
                ],
            })
        );

        expect(reason).toContain('Welcome wagon');
        expect(reason).toContain('Age check');
    });
});

describe('describeAttachIntent', () => {
    it('describes a first attach as gaining a journey', () => {
        const copy = describeAttachIntent({
            currentJourneyName: undefined,
            targetJourneyName: 'Onboarding',
        });

        expect(copy).toContain('Onboarding');
        expect(copy).not.toMatch(/move/i);
    });

    /**
     * **The constraint this whole test file exists for.**
     *
     * A flow has at most one journey — the unique index on `(guildId, flowId)` says so —
     * and `attach` is an upsert, so attaching an already-attached flow *moves* it. Copy
     * that says "attach" flatly implies the flow ends up on both and that what it
     * installs today is unaffected. Neither is true, and the operator would find out by
     * watching their install plan change.
     */
    it('says a flow that already has a journey is being moved, and names both', () => {
        const copy = describeAttachIntent({
            currentJourneyName: 'Rules',
            targetJourneyName: 'Onboarding',
        });

        expect(copy).toMatch(/move/i);
        expect(copy).toContain('Rules');
        expect(copy).toContain('Onboarding');
        // Explicitly rules out the reading the copy exists to prevent.
        expect(copy).toContain('not be on both');
    });
});

describe('describeDetachIntent', () => {
    /**
     * Detach leaves `resource_bindings` alone, so it must not read as an uninstall.
     *
     * Those rows name channels and roles that exist in the guild; an operator who reads
     * "detach" as "undo the install" goes looking for channels that are still there.
     */
    it('says the journey and anything installed both stay', () => {
        const copy = describeDetachIntent({ journeyName: 'Onboarding', sharedWith: [] });

        expect(copy).toContain('journey itself stays');
        expect(copy).toMatch(/already put in your server/i);
        expect(copy).toMatch(/separate step/i);
    });

    it('names the flows still holding the journey', () => {
        const copy = describeDetachIntent({
            journeyName: 'Onboarding',
            sharedWith: [
                { flowId: 'b', name: 'Age check' },
                { flowId: 'c', name: 'Rules ack' },
            ],
        });

        expect(copy).toContain('Age check');
        expect(copy).toContain('Rules ack');
        expect(copy).toContain('are still attached');
    });

    it('uses the singular for one remaining flow', () => {
        const copy = describeDetachIntent({
            journeyName: 'Onboarding',
            sharedWith: [{ flowId: 'b', name: 'Age check' }],
        });

        expect(copy).toContain('The flow');
        expect(copy).toContain('is still attached');
    });
});

describe('attachableJourneys', () => {
    it('excludes the journey the flow is already on', () => {
        // Re-attaching where it already is does nothing, and an option that is a no-op
        // invites the operator to wonder what it did.
        const options = attachableJourneys(
            [journey(), journey({ journeyKey: 'rules', name: 'Rules' })],
            'onboarding'
        );

        expect(options.map((entry) => entry.journeyKey)).toEqual(['rules']);
    });

    it('offers everything when the flow is attached to nothing', () => {
        const options = attachableJourneys(
            [journey(), journey({ journeyKey: 'rules', name: 'Rules' })],
            undefined
        );

        expect(options).toHaveLength(2);
    });
});
