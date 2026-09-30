import { describe, expect, it } from 'vitest';
import { shouldConfirmLeave } from '../leaveGuard';

const BUILDER = '/flows/42';

describe('shouldConfirmLeave', () => {
    it('asks before unsaved work leaves the page', () => {
        expect(shouldConfirmLeave({ unsaved: true, fromPath: BUILDER, toPath: '/flows' })).toBe(true);
    });

    it('lets a saved canvas go without asking', () => {
        expect(shouldConfirmLeave({ unsaved: false, fromPath: BUILDER, toPath: '/flows' })).toBe(false);
    });

    // The `?install=1` hand-off strips itself with a navigation to the same path.
    it('does not ask about a navigation that stays on the page', () => {
        expect(shouldConfirmLeave({ unsaved: true, fromPath: BUILDER, toPath: BUILDER })).toBe(false);
    });
});
