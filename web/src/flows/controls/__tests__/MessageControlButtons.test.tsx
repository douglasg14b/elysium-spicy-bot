import { StrictMode, useState } from 'react';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BlockButtonListener, BlockConfigField, DiscordMessage, MessageButton } from '@brattybot/web-sdk';
import { NO_JOURNEY } from '../../../__tests__/support/noJourney';
import { NO_UPLOADS } from '../../../__tests__/support/noUploads';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { ALL_REQUIREMENTS_AVAILABLE } from '../../variables';
import { MessageControl } from '../MessageControl';
import type { ControlContext } from '../types';

/**
 * A block's `message` field with a `buttonsKey`: the message window draws the buttons held in
 * that sibling key under the embeds and writes every change back there through
 * `setConfigKey`, as the inspector patches a picker's sidecar. The node's whole config is held
 * in real state, so each edit lands on the one before it.
 */

const RULES: DiscordMessage = { embeds: [{ title: 'House rules' }] };
const SAFEWORD: MessageButton = { key: 'safeword', label: 'Red', style: 'Danger' };

const WITH_BUTTONS: Extract<BlockConfigField, { control: 'message' }> = {
    key: 'message',
    label: 'Message',
    control: 'message',
    buttonsKey: 'buttons',
};

type Write = readonly [key: string, value: unknown];

interface HarnessProps {
    readonly field: typeof WITH_BUTTONS;
    readonly initial: Record<string, unknown>;
    readonly writes: Write[];
    readonly blockListeners: BlockButtonListener[];
}

function Harness({ field, initial, writes, blockListeners }: HarnessProps) {
    const [config, setConfig] = useState(initial);
    const context: ControlContext = {
        roles: [],
        channels: [],
        ticketTypes: [],
        variables: [],
        requirements: ALL_REQUIREMENTS_AVAILABLE,
        declaredResources: [],
        setConfigKey: (key, value) => {
            writes.push([key, value]);
            setConfig((current) => ({ ...current, [key]: value }));
        },
        uploads: NO_UPLOADS,
        ...NO_JOURNEY,
        listeners: { ...NO_JOURNEY.listeners, blockListeners },
    };
    return (
        <MessageControl
            field={field}
            value={config.message}
            onChange={(next) => setConfig((current) => ({ ...current, message: next }))}
            context={context}
            config={config}
        />
    );
}

async function openWindow(
    field: typeof WITH_BUTTONS,
    initial: Record<string, unknown>,
    blockListeners: BlockButtonListener[] = []
) {
    const writes: Write[] = [];
    const rendered = renderWithProviders(
        <StrictMode>
            <Harness field={field} initial={initial} writes={writes} blockListeners={blockListeners} />
        </StrictMode>
    );
    await rendered.user.click(screen.getByRole('button', { name: 'Edit message' }));
    return { ...rendered, writes, window: screen.getByRole('dialog') };
}

describe('a message field that keeps buttons beside it', () => {
    it('draws the buttons from their own key, with nobody listening yet', async () => {
        const { window } = await openWindow(WITH_BUTTONS, { message: RULES, buttons: [SAFEWORD] });

        expect(within(window).getByRole('button', { name: 'Red' })).toBeTruthy();
        expect(within(window).getByText('↳ Nothing listening yet')).toBeTruthy();
    });

    it('writes an added button into that key, not into the message', async () => {
        const { user, writes, window } = await openWindow(WITH_BUTTONS, { message: RULES });

        await user.click(within(window).getByRole('button', { name: 'Add button' }));

        expect(writes).toEqual([['buttons', [{ key: 'new-button', label: 'New button', style: 'Primary' }]]]);
    });

    it('writes nothing into the buttons on Cancel when only the message was touched', async () => {
        const { user, writes, window } = await openWindow(WITH_BUTTONS, { message: RULES });

        // An edit to the message re-renders the control, which reads the buttons again.
        await user.click(within(window).getByRole('button', { name: 'Embed 1 title' }));
        await user.type(within(window).getByRole('textbox', { name: 'Embed 1 title' }), '!');
        await user.click(within(window).getByRole('button', { name: 'Cancel' }));

        expect(writes).toEqual([]);
    });

    it('leaves out a stored button with a style the window cannot draw, rather than breaking', async () => {
        const { window } = await openWindow(WITH_BUTTONS, {
            message: RULES,
            buttons: [SAFEWORD, { key: 'shouty', label: 'Shouty', style: 'primary' }],
        });

        expect(within(window).getByRole('button', { name: 'Red' })).toBeTruthy();
        expect(within(window).queryByRole('button', { name: 'Shouty' })).toBeNull();
    });

    it("names who listens to this node's own buttons, locks a listened key, and asks before removing it", async () => {
        const aftercare: BlockButtonListener = {
            messageFlowId: NO_JOURNEY.listeners.flowId,
            messageNodeId: NO_JOURNEY.listeners.nodeId,
            buttonKey: 'safeword',
            flowId: 'aftercare',
            flowName: 'Aftercare',
            nodeId: 'press',
            enabled: true,
        };
        // Same key, another node's post: not this message's listener.
        const elsewhere: BlockButtonListener = { ...aftercare, messageNodeId: 'other-post', flowName: 'Elsewhere' };
        const { user, writes, window } = await openWindow(
            WITH_BUTTONS,
            { message: RULES, buttons: [SAFEWORD] },
            [aftercare, elsewhere]
        );

        expect(within(window).getByText('↳ Aftercare')).toBeTruthy();
        expect(within(window).queryByText(/Elsewhere/)).toBeNull();

        await user.click(within(window).getByRole('button', { name: 'Red' }));
        const key = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
        expect(key.readOnly).toBe(true);

        await user.click(screen.getByRole('button', { name: 'Remove button' }));
        expect(
            screen.getByText('Aftercare listens to this button. Remove it anyway? That trigger will need another button.')
        ).toBeTruthy();
        expect(writes).toEqual([]);
    });

    it('draws no buttons for a field that names no key for them', async () => {
        const { buttonsKey: _none, ...withoutButtons } = WITH_BUTTONS;
        const { window } = await openWindow(withoutButtons, { message: RULES, buttons: [SAFEWORD] });

        expect(within(window).queryByRole('button', { name: 'Add button' })).toBeNull();
        expect(within(window).queryByRole('button', { name: 'Red' })).toBeNull();
    });
});
