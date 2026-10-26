import { StrictMode, useState } from 'react';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ButtonListener, DiscordMessage, MessageButton } from '@brattybot/web-sdk';
import { NO_UPLOADS } from '../../../__tests__/support/noUploads';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { ALL_REQUIREMENTS_AVAILABLE } from '../../variables';
import { MessageEditor } from '../MessageEditor';

/**
 * The message window as a message resource opens it: no tokens anywhere, and a row of buttons
 * under the embeds. The message and the buttons are held in real state, as the Resources row
 * holds them, and every value each emits is recorded.
 */

const RULES: DiscordMessage = { embeds: [{ title: 'House rules', thumbnail: 'https://cdn.example.com/logo.png' }] };
const LET_ME_IN: MessageButton = { key: 'let-me-in', label: 'Let me in', style: 'Success' };

interface Emitted {
    readonly messages: (DiscordMessage | undefined)[];
    readonly buttons: MessageButton[][];
}

interface HarnessProps {
    readonly emitted: Emitted;
    readonly initialButtons: readonly MessageButton[];
    readonly listeners: readonly ButtonListener[];
}

function Harness({ emitted, initialButtons, listeners }: HarnessProps) {
    const [message, setMessage] = useState<unknown>(RULES);
    const [buttons, setButtons] = useState<readonly MessageButton[]>(initialButtons);
    const [open, setOpen] = useState(true);
    if (!open) return <p>closed</p>;
    return (
        <MessageEditor
            title="message"
            swatches={[]}
            value={message}
            onChange={(next) => {
                emitted.messages.push(next);
                setMessage(next);
            }}
            variables={[]}
            requirements={ALL_REQUIREMENTS_AVAILABLE}
            uploads={NO_UPLOADS}
            issues={[]}
            tokens={false}
            buttons={{
                value: buttons,
                onChange: (next) => {
                    emitted.buttons.push(next);
                    setButtons(next);
                },
                listeners,
            }}
            onClose={() => setOpen(false)}
        />
    );
}

function openWindow(initialButtons: readonly MessageButton[] = [LET_ME_IN], listeners: readonly ButtonListener[] = []) {
    const emitted: Emitted = { messages: [], buttons: [] };
    const rendered = renderWithProviders(
        <StrictMode>
            <Harness emitted={emitted} initialButtons={initialButtons} listeners={listeners} />
        </StrictMode>
    );
    return { ...rendered, emitted, window: screen.getByRole('dialog') };
}

describe('a message that takes no tokens', () => {
    it('offers no {x} on a part and no Token tab on a picture', async () => {
        const { user, window } = openWindow();

        await user.click(within(window).getByRole('button', { name: 'Embed 1 title' }));
        expect(within(window).getByRole('textbox', { name: 'Embed 1 title' })).toBeTruthy();
        expect(within(window).queryByRole('button', { name: /^Insert a token/ })).toBeNull();

        await user.click(within(window).getByRole('button', { name: 'Embed 1 thumbnail' }));
        expect(screen.getByRole('radio', { name: 'Upload' })).toBeTruthy();
        expect(screen.getByRole('radio', { name: 'Link' })).toBeTruthy();
        expect(screen.queryByRole('radio', { name: 'Token' })).toBeNull();
    });
});

describe('the buttons under the embeds', () => {
    it('draws each one, with what listens to it under it', () => {
        const { window } = openWindow();

        expect(within(window).getByRole('button', { name: 'Let me in' })).toBeTruthy();
        expect(within(window).getByText('↳ Nothing listening yet')).toBeTruthy();
    });

    it('adds "New button" with a key of its own, never an empty one', async () => {
        const { user, emitted, window } = openWindow([]);

        await user.click(within(window).getByRole('button', { name: 'Add button' }));
        await user.click(within(window).getByRole('button', { name: 'Add button' }));

        expect(emitted.buttons.at(-1)).toEqual([
            { key: 'new-button', label: 'New button', style: 'Primary' },
            { key: 'new-button-2', label: 'New button', style: 'Primary' },
        ]);
    });

    it('emits a new list for a label typed and a style picked, counting the label', async () => {
        const initial = [LET_ME_IN];
        const { user, emitted, window } = openWindow(initial);

        await user.click(within(window).getByRole('button', { name: 'Let me in' }));
        const label = screen.getByRole('textbox', { name: 'Label' });
        await user.type(label, '!');
        expect(screen.getByText('10 / 80')).toBeTruthy();
        await user.click(screen.getByRole('radio', { name: 'Red' }));

        expect(emitted.buttons.at(-1)).toEqual([{ key: 'let-me-in', label: 'Let me in!', style: 'Danger' }]);
        // A new list each time, never the one handed in edited in place.
        expect(emitted.buttons.at(-1)).not.toBe(initial);
        expect(initial).toEqual([LET_ME_IN]);
    });

    it('offers no 26th button', () => {
        const full = Array.from({ length: 25 }, (_unused, index): MessageButton => ({
            key: `b${index}`,
            label: `B${index}`,
            style: 'Secondary',
        }));
        const { window } = openWindow(full);

        expect(within(window).queryByRole('button', { name: 'Add button' })).toBeNull();
        expect(within(window).getByText(/25 of 25/)).toBeTruthy();
    });

    it('takes a button off from its box', async () => {
        const { user, emitted, window } = openWindow([LET_ME_IN, { key: 'nope', label: 'Nope', style: 'Danger' }]);

        await user.click(within(window).getByRole('button', { name: 'Nope' }));
        await user.click(screen.getByRole('button', { name: 'Remove button' }));

        expect(emitted.buttons.at(-1)).toEqual([LET_ME_IN]);
    });
});

describe('a button a flow listens to', () => {
    const WELCOME: ButtonListener = {
        messageKey: 'rules-panel',
        buttonKey: 'let-me-in',
        flowId: 'welcome',
        flowName: 'Welcome',
        nodeId: 'trigger-1',
        enabled: true,
    };
    const NOPE: MessageButton = { key: 'nope', label: 'Nope', style: 'Danger' };

    it('names the flow under it, and nothing under the one nobody listens to', () => {
        const { window } = openWindow([LET_ME_IN, NOPE], [WELCOME]);

        expect(within(window).getByText('↳ Welcome')).toBeTruthy();
        expect(within(window).getAllByText('↳ Nothing listening yet')).toHaveLength(1);
    });

    /**
     * A press is routed by the key, so renaming it would leave Welcome naming a button that is
     * gone. `readOnly` rather than `disabled`: a focused field that stops being focusable throws
     * the cursor away.
     */
    it('locks its key, readOnly and never disabled, and leaves a free button’s key editable', async () => {
        const { user, window } = openWindow([LET_ME_IN, NOPE], [WELCOME]);

        await user.click(within(window).getByRole('button', { name: 'Let me in' }));
        const locked = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
        expect(locked.readOnly).toBe(true);
        expect(locked.disabled).toBe(false);
        expect(screen.getByText('Fixed — Welcome listens for it.')).toBeTruthy();

        // A click on another button shuts this box and opens that one's.
        await user.click(within(window).getByRole('button', { name: 'Nope' }));
        expect((screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement).readOnly).toBe(false);
    });

    it('asks before Remove takes it, and keeps it when told to', async () => {
        const { user, emitted, window } = openWindow([LET_ME_IN, NOPE], [WELCOME]);

        await user.click(within(window).getByRole('button', { name: 'Let me in' }));
        await user.click(screen.getByRole('button', { name: 'Remove button' }));

        expect(
            screen.getByText('Welcome listens to this button. Remove it anyway? That trigger will need another button.')
        ).toBeTruthy();
        expect(emitted.buttons).toEqual([]);

        await user.click(screen.getByRole('button', { name: 'Keep it' }));
        expect(emitted.buttons).toEqual([]);

        await user.click(screen.getByRole('button', { name: 'Remove button' }));
        await user.click(screen.getByRole('button', { name: 'Remove anyway' }));
        expect(emitted.buttons.at(-1)).toEqual([NOPE]);
    });
});

describe('Cancel', () => {
    it('puts back the message and the buttons as they were when the window opened', async () => {
        const { user, emitted, window } = openWindow();

        await user.click(within(window).getByRole('button', { name: 'Embed 1 title' }));
        await user.type(within(window).getByRole('textbox', { name: 'Embed 1 title' }), ', revised');
        await user.click(within(window).getByRole('button', { name: 'Add button' }));
        expect(emitted.buttons.at(-1)).toHaveLength(2);

        await user.click(within(window).getByRole('button', { name: 'Cancel' }));

        expect(emitted.messages.at(-1)).toEqual(RULES);
        expect(emitted.buttons.at(-1)).toEqual([LET_ME_IN]);
        expect(screen.getByText('closed')).toBeTruthy();
    });
});
