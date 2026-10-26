import { describe, expect, it } from 'vitest';
import type { BlockConfigField, ButtonListener } from '@brattybot/web-sdk';
import { buttonHolder, cutOffQuestion, overlayCanvasListeners } from '../buttonListeners';

/**
 * The listener decisions the picker, the message window and the removals share: the builder's
 * own picks laid over the server's answer, who holds a button, and the question a removal asks.
 */

const BUTTON_FIELD: BlockConfigField = { key: 'button', label: 'Button', control: 'messageButton' };

function listener(overrides: Partial<ButtonListener>): ButtonListener {
    return {
        messageKey: 'rules-panel',
        buttonKey: 'let-me-in',
        flowId: 'welcome',
        flowName: 'Welcome',
        nodeId: 'press',
        enabled: true,
        ...overrides,
    };
}

describe('overlayCanvasListeners', () => {
    it("replaces this flow's saved picks with the ones on the canvas, and keeps everyone else's", () => {
        const answer = [
            listener({}),
            // Saved a while ago; the canvas has since moved this trigger to another button.
            listener({ flowId: 'gate', flowName: 'Old gate name', nodeId: 'gate-press', buttonKey: 'nope' }),
        ];

        const overlaid = overlayCanvasListeners(answer, {
            flowId: 'gate',
            flowName: 'Gate',
            enabled: false,
            nodes: [
                {
                    id: 'gate-press',
                    fields: [BUTTON_FIELD],
                    config: { button: { messageKey: 'rules-panel', buttonKey: 'spank-me' } },
                },
                // Nothing picked yet, and a block this build does not know: neither listens.
                { id: 'unpicked', fields: [BUTTON_FIELD], config: {} },
                {
                    id: 'unknown',
                    fields: undefined,
                    config: { button: { messageKey: 'rules-panel', buttonKey: 'nope' } },
                },
            ],
        });

        expect(overlaid).toEqual([
            listener({}),
            listener({ flowId: 'gate', flowName: 'Gate', nodeId: 'gate-press', buttonKey: 'spank-me', enabled: false }),
        ]);
    });
});

describe('buttonHolder', () => {
    const view = (all: ButtonListener[]) => ({ all, flowId: 'gate', nodeId: 'gate-press' });
    const pick = { messageKey: 'rules-panel', buttonKey: 'let-me-in' };

    it('names another flow even when this node holds the button too, and counts one switched off', () => {
        expect(
            buttonHolder(view([listener({ enabled: false }), listener({ flowId: 'gate', nodeId: 'gate-press' })]), pick)
        ).toEqual({ kind: 'otherFlows', flowNames: ['Welcome'] });
    });

    it("tells this node's own pick from another trigger's in the same flow", () => {
        const own = listener({ flowId: 'gate', nodeId: 'gate-press' });
        const sibling = listener({ flowId: 'gate', nodeId: 'other-press' });

        expect(buttonHolder(view([own]), pick)).toEqual({ kind: 'thisNode' });
        expect(buttonHolder(view([sibling]), pick)).toEqual({ kind: 'thisFlow' });
        expect(buttonHolder(view([]), pick)).toEqual({ kind: 'nobody' });
    });
});

describe('cutOffQuestion', () => {
    it('names every flow once, and speaks of the triggers in the plural when there are several', () => {
        const several = [listener({}), listener({ nodeId: 'second' }), listener({ flowId: 'gate', flowName: 'Gate' })];

        expect(cutOffQuestion(several, 'message')).toBe(
            'Welcome and Gate listen to a button on this message. Remove it anyway? Those triggers will need another button.'
        );
    });
});
