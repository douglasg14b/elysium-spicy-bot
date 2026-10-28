import { describe, expect, it } from 'vitest';
import type { BlockButtonListener, BlockButtonMessage, BlockConfigField, ButtonListener } from '@brattybot/web-sdk';
import { buttonHolder, cutOffQuestion, NO_BUTTON_ANSWER, overlayCanvas, readButtonPick } from '../buttonListeners';

/**
 * The listener decisions the picker, the message window and the removals share: the builder's
 * own picks and posts laid over the server's answer, who holds a button, and the question a
 * removal asks.
 */

const BUTTON_FIELD: BlockConfigField = { key: 'button', label: 'Button', control: 'messageButton' };
const MESSAGE_FIELD: BlockConfigField = { key: 'message', label: 'Message', control: 'message', buttonsKey: 'buttons' };

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

function blockListener(overrides: Partial<BlockButtonListener>): BlockButtonListener {
    return {
        messageFlowId: 'welcome',
        messageNodeId: 'post',
        buttonKey: 'spank-me',
        flowId: 'welcome',
        flowName: 'Welcome',
        nodeId: 'press',
        enabled: true,
        ...overrides,
    };
}

const WELCOME_POST: BlockButtonMessage = {
    flowId: 'welcome',
    flowName: 'Welcome',
    nodeId: 'post',
    blockLabel: 'Post Embed',
    headline: 'Hello, brat',
    buttons: [{ key: 'spank-me', label: 'Spank me', style: 'Danger' }],
};

describe('readButtonPick', () => {
    it("reads either arm, a message key winning as the server's union has it", () => {
        expect(readButtonPick({ messageKey: 'rules-panel', buttonKey: 'nope' })).toEqual({
            messageKey: 'rules-panel',
            buttonKey: 'nope',
        });
        expect(readButtonPick({ flowId: 'gate', nodeId: 'post', buttonKey: 'nope' })).toEqual({
            flowId: 'gate',
            nodeId: 'post',
            buttonKey: 'nope',
        });
        expect(readButtonPick({ flowId: 'gate', buttonKey: 'nope' })).toBeUndefined();
        expect(readButtonPick({ messageKey: 'rules-panel' })).toBeUndefined();
    });
});

describe('overlayCanvas', () => {
    it("replaces this flow's saved picks with the ones on the canvas, and keeps everyone else's", () => {
        const answer = {
            ...NO_BUTTON_ANSWER,
            listeners: [
                listener({}),
                // Saved a while ago; the canvas has since moved this trigger to another button.
                listener({ flowId: 'gate', flowName: 'Old gate name', nodeId: 'gate-press', buttonKey: 'nope' }),
            ],
        };

        const overlaid = overlayCanvas(answer, {
            flowId: 'gate',
            flowName: 'Gate',
            enabled: false,
            nodes: [
                {
                    id: 'gate-press',
                    blockLabel: 'Button Click',
                    fields: [BUTTON_FIELD],
                    config: { button: { messageKey: 'rules-panel', buttonKey: 'spank-me' } },
                },
                // Nothing picked yet, and a block this build does not know: neither listens.
                { id: 'unpicked', blockLabel: 'Button Click', fields: [BUTTON_FIELD], config: {} },
                {
                    id: 'unknown',
                    blockLabel: undefined,
                    fields: undefined,
                    config: { button: { messageKey: 'rules-panel', buttonKey: 'nope' } },
                },
            ],
        });

        expect(overlaid.listeners).toEqual([
            listener({}),
            listener({ flowId: 'gate', flowName: 'Gate', nodeId: 'gate-press', buttonKey: 'spank-me', enabled: false }),
        ]);
    });

    it("keeps a block pick's poster ids apart from the listener's own, and offers this flow's posts first", () => {
        // A trigger in "gate" naming a button under one of "welcome"'s posts: the pick's own
        // `flowId`/`nodeId` are the poster's, and must not land where the listener's go.
        const answer = {
            listeners: [],
            blockMessages: [WELCOME_POST],
            blockListeners: [blockListener({ flowId: 'gate', flowName: 'Old gate name', nodeId: 'gate-press' })],
        };

        const overlaid = overlayCanvas(answer, {
            flowId: 'gate',
            flowName: 'Gate',
            enabled: true,
            nodes: [
                {
                    id: 'gate-press',
                    blockLabel: 'Button Click',
                    fields: [BUTTON_FIELD],
                    config: { button: { flowId: 'welcome', nodeId: 'post', buttonKey: 'spank-me' } },
                },
                {
                    id: 'gate-post',
                    blockLabel: 'Post Embed',
                    fields: [MESSAGE_FIELD],
                    config: {
                        message: { embeds: [{ title: 'Kneel' }] },
                        buttons: [{ key: 'kneel', label: 'Kneel', style: 'Primary' }],
                    },
                },
            ],
        });

        expect(overlaid.blockListeners).toEqual([
            blockListener({ flowId: 'gate', flowName: 'Gate', nodeId: 'gate-press' }),
        ]);
        expect(overlaid.blockMessages).toEqual([
            {
                flowId: 'gate',
                flowName: 'Gate',
                nodeId: 'gate-post',
                blockLabel: 'Post Embed',
                headline: 'Kneel',
                buttons: [{ key: 'kneel', label: 'Kneel', style: 'Primary' }],
            },
            WELCOME_POST,
        ]);
        expect(overlaid.listeners).toEqual([]);
    });
});

describe('buttonHolder', () => {
    const view = (listeners: ButtonListener[], blockListeners: BlockButtonListener[] = []) => ({
        listeners,
        blockMessages: [],
        blockListeners,
        flowId: 'gate',
        nodeId: 'gate-press',
    });
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

    it("matches a block's button by the exact poster and key, never by a journey message's keys", () => {
        const blockPick = { flowId: 'welcome', nodeId: 'post', buttonKey: 'spank-me' };
        const welcomeHolds = blockListener({});

        expect(buttonHolder(view([], [welcomeHolds]), blockPick)).toEqual({ kind: 'otherFlows', flowNames: ['Welcome'] });
        expect(buttonHolder(view([], [welcomeHolds]), { ...blockPick, nodeId: 'other-post' })).toEqual({ kind: 'nobody' });
        expect(buttonHolder(view([listener({ buttonKey: 'spank-me' })], []), blockPick)).toEqual({ kind: 'nobody' });
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
