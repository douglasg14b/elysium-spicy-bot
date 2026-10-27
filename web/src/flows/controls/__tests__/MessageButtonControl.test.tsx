import { useEffect, useState } from 'react';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
    BlockConfigField,
    ButtonListener,
    GuildChannel,
    GuildEmoji,
    MessageButton,
    ResourceDeclaration,
} from '@brattybot/web-sdk';
import { NO_UPLOADS } from '../../../__tests__/support/noUploads';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { ALL_REQUIREMENTS_AVAILABLE } from '../../variables';
import { MessageButtonControl } from '../MessageButtonControl';
import type { ControlContext, JourneyHoldings } from '../types';

/**
 * The Button Click trigger's picker: a message, then one of its buttons, either of them made on
 * the spot.
 *
 * The declarations and the stored pick are held in real state, as the builder holds them, so
 * what is asserted is what the page would save: the button in the message's declaration and
 * the pick in the node, from one click.
 *
 * The emoji grid is stood in for at its package (`stubEmojiPicker`), as the message window's
 * tests do.
 */

vi.mock('emoji-picker-react', async (importOriginal) => {
    const { stubEmojiPickerModule } = await import('../../../__tests__/support/stubEmojiPicker');
    return stubEmojiPickerModule(await importOriginal<typeof import('emoji-picker-react')>());
});

const BLOBHEART: GuildEmoji = { id: '112233445566778899', name: 'blobheart', animated: false };

const FIELD: Extract<BlockConfigField, { control: 'messageButton' }> = {
    key: 'button',
    label: 'Button',
    control: 'messageButton',
};

const LET_ME_IN: MessageButton = { key: 'let-me-in', label: 'Let me in', style: 'Success' };
const NOPE: MessageButton = { key: 'nope', label: 'Nope', style: 'Danger' };

const RULES_CHANNEL: ResourceDeclaration = { key: 'rules', kind: 'textChannel', defaultName: 'rules' };
const RULES_PANEL: ResourceDeclaration = {
    key: 'rules-panel',
    kind: 'message',
    defaultName: 'Rules panel',
    parentKey: 'rules',
    message: { embeds: [{ title: 'House rules' }] },
    buttons: [LET_ME_IN, NOPE],
};

const THIS_FLOW = 'this-flow';
const THIS_NODE = 'trigger-1';
const JOURNEY_KEY = 'welcome-journey';

const WELCOME_LISTENS: ButtonListener = {
    messageKey: 'rules-panel',
    buttonKey: 'let-me-in',
    flowId: 'welcome',
    flowName: 'Welcome',
    nodeId: 'welcome-trigger',
    enabled: true,
};

function textChannel(id: string, name: string, owner: GuildChannel['owner'] = null): GuildChannel {
    return { id, name, type: 'text', parentId: null, parentName: null, owner };
}

/** What the harness last held, and every value the control emitted. */
interface Recorded {
    declared: readonly ResourceDeclaration[];
    value: unknown;
    readonly changes: unknown[];
}

interface HarnessProps {
    readonly record: Recorded;
    readonly initialDeclared: readonly ResourceDeclaration[];
    readonly initialValue: unknown;
    readonly listeners: readonly ButtonListener[];
    readonly channels: GuildChannel[];
    readonly journey: JourneyHoldings;
    readonly serverEmojis?: readonly GuildEmoji[];
    readonly error?: string;
}

function Harness({ record, initialDeclared, initialValue, listeners, channels, journey, serverEmojis, error }: HarnessProps) {
    const [declared, setDeclared] = useState<ResourceDeclaration[]>([...initialDeclared]);
    const [value, setValue] = useState<unknown>(initialValue);

    useEffect(() => {
        record.declared = declared;
        record.value = value;
    }, [record, declared, value]);

    const context: ControlContext = {
        roles: [],
        channels,
        ticketTypes: [],
        variables: [],
        requirements: ALL_REQUIREMENTS_AVAILABLE,
        declaredResources: declared,
        setConfigKey: () => {
            throw new Error('The button picker writes no resource sidecar.');
        },
        uploads: NO_UPLOADS,
        ...(serverEmojis ? { serverEmojis } : {}),
        declareResources: (update) => setDeclared((current) => update(current)),
        listeners: { all: listeners, flowId: THIS_FLOW, nodeId: THIS_NODE },
        journey,
    };

    return (
        <MessageButtonControl
            field={FIELD}
            value={value}
            onChange={(next) => {
                record.changes.push(next);
                setValue(next);
            }}
            context={context}
            error={error}
        />
    );
}

interface RenderOptions {
    readonly declared?: readonly ResourceDeclaration[];
    readonly value?: unknown;
    readonly listeners?: readonly ButtonListener[];
    readonly channels?: GuildChannel[];
    readonly journey?: JourneyHoldings;
    readonly serverEmojis?: readonly GuildEmoji[];
    readonly error?: string;
}

function renderPicker(options: RenderOptions = {}) {
    const record: Recorded = { declared: [], value: undefined, changes: [] };
    const rendered = renderWithProviders(
        <Harness
            record={record}
            initialDeclared={options.declared ?? [RULES_CHANNEL, RULES_PANEL]}
            initialValue={options.value}
            listeners={options.listeners ?? []}
            channels={options.channels ?? []}
            journey={options.journey ?? { key: JOURNEY_KEY, boundKeys: new Map() }}
            serverEmojis={options.serverEmojis}
            error={options.error}
        />
    );
    return { ...rendered, record };
}

const messageSelect = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLInputElement;
const buttonSelect = () => screen.getByRole('textbox', { name: 'Button' }) as HTMLInputElement;

describe('picking a button', () => {
    it("lists the journey's messages with where each is posted, then that message's buttons", async () => {
        const { user, record } = renderPicker();

        await user.click(messageSelect());
        const option = screen.getByRole('option', { name: /^Rules panel/ });
        expect(option.textContent).toContain('in #rules');
        await user.click(option);

        await user.click(buttonSelect());
        expect(screen.getByRole('option', { name: /^Let me in/ })).toBeTruthy();
        await user.click(screen.getByRole('option', { name: /^Nope/ }));

        expect(record.changes).toEqual([{ messageKey: 'rules-panel', buttonKey: 'nope' }]);
    });

    it('greys a button another flow listens to, names that flow, and will not take it', async () => {
        const { user, record } = renderPicker({
            value: { messageKey: 'rules-panel', buttonKey: 'nope' },
            listeners: [WELCOME_LISTENS],
        });

        await user.click(buttonSelect());
        const taken = screen.getByRole('option', { name: /^Let me in/ });
        expect(taken.getAttribute('data-combobox-disabled')).toBe('true');
        expect(taken.textContent).toContain('↳ Welcome');

        await user.click(taken);
        expect(record.changes).toEqual([]);
        expect(screen.getByRole('option', { name: /^Nope/ }).getAttribute('data-combobox-disabled')).toBeNull();
    });

    it('says "this flow" under the button this trigger holds, and leaves it pickable', async () => {
        const own: ButtonListener = { ...WELCOME_LISTENS, flowId: THIS_FLOW, flowName: 'Welcome', nodeId: THIS_NODE };
        const { user } = renderPicker({ value: { messageKey: 'rules-panel', buttonKey: 'let-me-in' }, listeners: [own] });

        await user.click(buttonSelect());
        const held = screen.getByRole('option', { name: /^Let me in/ });
        expect(held.textContent).toContain('↳ this flow');
        expect(held.getAttribute('data-combobox-disabled')).toBeNull();
    });

    it('keeps a pick that is gone shown, marked, with the readiness issue under the field', () => {
        renderPicker({
            value: { messageKey: 'rules-panel', buttonKey: 'spank-me' },
            error: 'Rules panel has no button "spank-me" any more.',
        });

        expect(buttonSelect().value).toBe('spank-me — not on this message any more');
        expect(screen.getByText('Rules panel has no button "spank-me" any more.')).toBeTruthy();
    });

    it('says so when the journey has no messages yet', () => {
        renderPicker({ declared: [RULES_CHANNEL] });

        expect(screen.getByText("This flow's journey has no messages yet.")).toBeTruthy();
        expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    });
});

describe('"New button on this message"', () => {
    it('writes the button into the declaration and the pick into the node in one step', async () => {
        const bare: ResourceDeclaration = { ...RULES_PANEL, buttons: [] };
        const { user, record } = renderPicker({ declared: [RULES_CHANNEL, bare] });

        await user.click(messageSelect());
        await user.click(screen.getByRole('option', { name: /^Rules panel/ }));
        expect(screen.getByText(/has no buttons yet/)).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'New button on this message' }));
        await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Get spanked');
        await user.click(screen.getByRole('radio', { name: 'Red' }));
        await user.click(screen.getByRole('button', { name: 'Add' }));

        const message = record.declared.find((resource) => resource.key === 'rules-panel');
        expect(message?.buttons).toEqual([{ key: 'get-spanked', label: 'Get spanked', style: 'Danger' }]);
        expect(record.changes).toEqual([{ messageKey: 'rules-panel', buttonKey: 'get-spanked' }]);
        expect(buttonSelect().value).toBe('Get spanked');
    });

    it('keys a second button with the same label apart from the first', async () => {
        const { user, record } = renderPicker({ value: { messageKey: 'rules-panel', buttonKey: 'nope' } });

        await user.click(screen.getByRole('button', { name: 'New button on this message' }));
        await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Let me in');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        expect(record.changes.at(-1)).toEqual({ messageKey: 'rules-panel', buttonKey: 'let-me-in-2' });
    });

    it("adds a button with an emoji and no label, keyed by the server emoji's name", async () => {
        const { user, record } = renderPicker({ value: { messageKey: 'rules-panel', buttonKey: 'nope' }, serverEmojis: [BLOBHEART] });

        await user.click(screen.getByRole('button', { name: 'New button on this message' }));
        const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
        expect(add.disabled).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Pick an emoji' }));
        await user.click(await screen.findByRole('button', { name: 'blobheart' }));
        expect(add.disabled).toBe(false);
        await user.click(add);

        const message = record.declared.find((resource) => resource.key === 'rules-panel');
        expect(message?.buttons?.at(-1)).toStrictEqual({
            key: 'blobheart',
            style: 'Primary',
            emoji: { id: BLOBHEART.id, name: 'blobheart', animated: false },
        });
        expect(record.changes.at(-1)).toEqual({ messageKey: 'rules-panel', buttonKey: 'blobheart' });
        expect(buttonSelect().value).toBe(':blobheart:');
    });

    it('keys a standard emoji with no label "button", its glyph alone', async () => {
        const { user, record } = renderPicker({ value: { messageKey: 'rules-panel', buttonKey: 'nope' } });

        await user.click(screen.getByRole('button', { name: 'New button on this message' }));
        await user.click(screen.getByRole('button', { name: 'Pick an emoji' }));
        await user.click(await screen.findByRole('button', { name: 'smiling face with horns' }));
        await user.click(screen.getByRole('button', { name: 'Add' }));

        const message = record.declared.find((resource) => resource.key === 'rules-panel');
        expect(message?.buttons?.at(-1)).toStrictEqual({ key: 'button', style: 'Primary', emoji: { name: '\u{1F608}' } });
    });

    it('shuts only the grid on Escape, keeping the label typed so far', async () => {
        const { user } = renderPicker({ value: { messageKey: 'rules-panel', buttonKey: 'nope' } });

        await user.click(screen.getByRole('button', { name: 'New button on this message' }));
        await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Brat');
        await user.click(screen.getByRole('button', { name: 'Pick an emoji' }));
        await user.click(await screen.findByRole('textbox', { name: 'Type to search for an emoji' }));
        await user.keyboard('{Escape}');

        expect(screen.queryByRole('grid', { name: 'Emoji grid' })).toBeNull();
        expect((screen.getByRole('textbox', { name: 'Label' }) as HTMLInputElement).value).toBe('Brat');

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('textbox', { name: 'Label' })).toBeNull();
    });
});

describe('a button with an emoji', () => {
    it('names an emoji-only button by its emoji, and draws the emoji on its face', async () => {
        const hearted: MessageButton = { key: 'love', style: 'Primary', emoji: { id: BLOBHEART.id, name: 'blobheart', animated: false } };
        const { user } = renderPicker({
            declared: [RULES_CHANNEL, { ...RULES_PANEL, buttons: [LET_ME_IN, hearted] }],
            value: { messageKey: 'rules-panel', buttonKey: 'love' },
            serverEmojis: [BLOBHEART],
        });

        expect(buttonSelect().value).toBe(':blobheart:');
        await user.click(buttonSelect());
        const option = screen.getByRole('option', { name: /^:blobheart:/ });
        expect(option.querySelector('img')?.getAttribute('alt')).toBe(':blobheart:');
    });
});

describe('"New message in…"', () => {
    it('declares a server channel adopted, and a message in it, then asks for its first button', async () => {
        const { user, record } = renderPicker({ channels: [textChannel('c-lobby', 'lobby')] });

        await user.click(screen.getByRole('button', { name: 'New message in…' }));
        await user.click(screen.getByRole('menuitem', { name: /^#lobby/ }));

        expect(record.declared.slice(2)).toEqual([
            { key: 'lobby', kind: 'textChannel', defaultName: 'lobby', adoptDiscordId: 'c-lobby' },
            {
                key: 'new-message',
                kind: 'message',
                defaultName: 'New message',
                parentKey: 'lobby',
                message: { embeds: [{ title: 'New message' }] },
            },
        ]);
        expect(messageSelect().value).toBe('New message');
        // Nothing to pick yet: the message has no button, so the popover asks for one.
        expect(record.changes).toEqual([]);
        expect(screen.getByRole('textbox', { name: 'Label' })).toBeTruthy();
    });

    it('posts in a declared channel under its own key, and offers a channel it adopts only once', async () => {
        const adopted: ResourceDeclaration = { ...RULES_CHANNEL, adoptDiscordId: 'c-rules' };
        const { user, record } = renderPicker({
            declared: [adopted, RULES_PANEL],
            channels: [textChannel('c-rules', 'rules')],
        });

        await user.click(screen.getByRole('button', { name: 'New message in…' }));
        expect(screen.getAllByRole('menuitem', { name: /^#rules/ })).toHaveLength(1);
        await user.click(screen.getByRole('menuitem', { name: /^#rules/ }));

        expect(record.declared).toHaveLength(3);
        expect(record.declared[2]).toMatchObject({ kind: 'message', parentKey: 'rules' });
    });

    it('declares a channel the journey installed under the key it holds it by, not a second adoption', async () => {
        const { user, record } = renderPicker({
            channels: [textChannel('c-lounge', 'lounge', { kind: 'journey', key: JOURNEY_KEY, label: 'Welcome' })],
            journey: { key: JOURNEY_KEY, boundKeys: new Map([['c-lounge', 'old-lounge']]) },
        });

        await user.click(screen.getByRole('button', { name: 'New message in…' }));
        await user.click(screen.getByRole('menuitem', { name: /^#lounge/ }));

        expect(record.declared[2]).toEqual({ key: 'old-lounge', kind: 'textChannel', defaultName: 'lounge' });
        expect(record.declared[3]).toMatchObject({ kind: 'message', parentKey: 'old-lounge' });
    });

    it('greys a channel another journey or the ticket system holds', async () => {
        const { user, record } = renderPicker({
            channels: [
                textChannel('c-tickets', 'tickets', { kind: 'tickets', key: 'tickets', label: 'Tickets' }),
                textChannel('c-dungeon', 'dungeon', { kind: 'journey', key: 'other-journey', label: 'Dungeon tour' }),
            ],
        });

        await user.click(screen.getByRole('button', { name: 'New message in…' }));
        const tickets = screen.getByRole('menuitem', { name: /^#tickets/ }) as HTMLButtonElement;
        const dungeon = screen.getByRole('menuitem', { name: /^#dungeon/ }) as HTMLButtonElement;
        expect(tickets.disabled).toBe(true);
        expect(tickets.textContent).toContain('held by Tickets');
        expect(dungeon.disabled).toBe(true);
        expect(dungeon.textContent).toContain('held by Dungeon tour');

        await user.click(tickets);
        expect(record.declared).toHaveLength(2);
    });
});
