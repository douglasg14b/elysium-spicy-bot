import type { ControlContext } from '../../flows/controls/types';

/**
 * A flow on no journey, with nobody listening to any button, for a control test that never
 * touches either. Declaring a resource through it fails the test: a test that means to declare
 * one passes its own `declareResources`.
 */
export const NO_JOURNEY: Pick<ControlContext, 'declareResources' | 'listeners' | 'journey'> = {
    declareResources: () => {
        throw new Error('This test hands its controls no way to declare a resource.');
    },
    listeners: { all: [], flowId: 'test-flow', nodeId: 'test-node' },
    journey: { key: undefined, boundKeys: new Map() },
};
