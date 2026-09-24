import { describe, expect, it } from 'vitest';
import type { FlowJourneyMembership } from '../../api/types';
import { installChipFor } from '../installStateChip';

/**
 * The chip rule, which fails by being noisy rather than by throwing.
 *
 * A chip on every row is the failure mode `docs/contracts/resource-chips.md` exists to
 * prevent, and it is invisible to a typecheck and to a rendering test alike — the markup
 * is correct either way. These assert the *silences* as hard as the labels.
 */

function membership(overrides: Partial<FlowJourneyMembership> = {}): FlowJourneyMembership {
    return {
        journeyKey: 'onboarding',
        name: 'Onboarding',
        resourceCount: 4,
        memberCount: 2,
        installState: 'all',
        installedCount: 4,
        // Not read by the chip — it counts rather than names — but required by the type,
        // and a fixture that lied about it would be a bad template for a later test.
        installedKeys: ['a', 'b', 'c', 'd'],
        ...overrides,
    };
}

describe('installChipFor', () => {
    it('says nothing about a fully installed journey', () => {
        // The resting state of a journey that works. A chip here would sit on most rows
        // in a healthy guild and stop being read at all.
        expect(installChipFor(membership())).toBeNull();
    });

    it('says nothing when the journey declares no resources', () => {
        // "Not installed" would be true and useless: there is nothing to install.
        expect(
            installChipFor(membership({ resourceCount: 0, installState: 'none', installedCount: 0 }))
        ).toBeNull();
    });

    it('says nothing for a flow with no journey at all', () => {
        expect(installChipFor(null)).toBeNull();
    });

    it('flags a journey with nothing installed', () => {
        const chip = installChipFor(
            membership({ installState: 'none', installedCount: 0, resourceCount: 4 })
        );

        expect(chip?.label).toBe('Not installed');
        expect(chip?.tooltip).toContain('4 declared resources');
    });

    it('singularises the tooltip for a lone resource', () => {
        const chip = installChipFor(
            membership({ installState: 'none', installedCount: 0, resourceCount: 1 })
        );

        expect(chip?.tooltip).toContain('1 declared resource exist');
        expect(chip?.tooltip).not.toContain('resources');
    });

    it('distinguishes a half-finished install from one never started', () => {
        // Separate states because the fix reads differently: "set this up" versus "this
        // stopped halfway". The count is on the chip because it is the whole difference.
        const chip = installChipFor(
            membership({ installState: 'partial', installedCount: 3, resourceCount: 4 })
        );

        expect(chip?.label).toBe('3/4 installed');
    });

    it('uses a non-destructive colour — nothing here is damaged', () => {
        expect(installChipFor(membership({ installState: 'none', installedCount: 0 }))?.color).toBe(
            'orange'
        );
        expect(
            installChipFor(membership({ installState: 'partial', installedCount: 1 }))?.color
        ).toBe('orange');
    });
});

describe('the set of states that speak', () => {
    it('is exactly the two an operator can act on', () => {
        // Stated as a whole rather than one silence at a time, because the property the
        // chip rule actually has is about the *list*: a healthy guild shows no install
        // chips at all, so one appearing means one thing. A rule that crept to three
        // states would still pass every individual case above.
        const states: FlowJourneyMembership[] = [
            membership({ installState: 'none', installedCount: 0 }),
            membership({ installState: 'partial', installedCount: 2 }),
            membership({ installState: 'all', installedCount: 4 }),
            membership({ resourceCount: 0, installState: 'none', installedCount: 0 }),
        ];

        const speaking = states.filter((journey) => installChipFor(journey) !== null);

        expect(speaking.map((journey) => journey.installState)).toEqual(['none', 'partial']);
    });
});
