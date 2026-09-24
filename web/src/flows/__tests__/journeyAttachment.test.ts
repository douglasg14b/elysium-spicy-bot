import { describe, expect, it } from 'vitest';
import type { JourneySummary } from '../../api/types';
import {
    attachableJourneys,
    describeAttachIntent,
    describeDetachIntent,
    newJourneyNameFor,
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

describe('newJourneyNameFor', () => {
    it('reads as a container rather than as a copy of its first member', () => {
        // The live bug: dragging onto "Flow E" produced a header reading "Flow E",
        // directly above a member row also reading "Flow E".
        expect(newJourneyNameFor('Flow E')).toBe('Flow E journey');
    });

    it('keeps the operator\'s name first, so a list stays scannable', () => {
        expect(newJourneyNameFor('Onboarding')).toBe('Onboarding journey');
    });

    it('does not say journey twice', () => {
        expect(newJourneyNameFor('Welcome journey')).toBe('Welcome journey');
        expect(newJourneyNameFor('Welcome Journey')).toBe('Welcome Journey');
    });

    it('drops the suffix rather than truncating a name at the server\'s cap', () => {
        // `createJourneyBody` refuses names over 100 characters. The suffix is ours and
        // the name is theirs, so the suffix is what gives way.
        const long = 'a'.repeat(96);
        expect(newJourneyNameFor(long)).toBe(long);
        expect(newJourneyNameFor(long).length).toBeLessThanOrEqual(100);

        const justFits = 'a'.repeat(92);
        expect(newJourneyNameFor(justFits)).toBe(`${justFits} journey`);
        expect(newJourneyNameFor(justFits)).toHaveLength(100);
    });

    it('trims, so a padded flow name does not produce a padded journey name', () => {
        expect(newJourneyNameFor('  Rules  ')).toBe('Rules journey');
    });
});

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

/*
 * `deleteBlockedReason`'s tests were here. Removed 2026-09-22 with the function and the
 * journeys page it served — nothing deletes a journey from the client any more, so there
 * is no rule left to pin. The name-every-flow convention those tests guarded is still
 * enforced where it is still reachable: `sharedJourneyRefusal` on the server, and the
 * orphan warning in `GroupConflictDialog`.
 */

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
