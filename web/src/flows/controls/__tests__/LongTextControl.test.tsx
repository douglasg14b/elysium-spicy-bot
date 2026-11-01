import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BlockConfigField, GuildChannel, GuildRole, ManagedRole } from '@brattybot/web-sdk';
import { NO_JOURNEY } from '../../../__tests__/support/noJourney';
import { NO_UPLOADS } from '../../../__tests__/support/noUploads';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { ALL_REQUIREMENTS_AVAILABLE, type AvailableVariable } from '../../variables';
import { LongTextControl } from '../TextControls';
import type { ControlContext } from '../types';

/**
 * The inspector's long text box, for a field whose text lands where Discord shows a mention by
 * name (Ask a Question's question, Open Ticket's reason) and for one whose text does not (Send
 * DM's message). Driven as an author drives it: type `@` or `#`, pick, keep typing.
 */

type LongTextField = Extract<BlockConfigField, { control: 'longText' }>;

/** As Ask a Question declares its question. */
const QUESTION: LongTextField = {
    key: 'question',
    label: 'Question',
    control: 'longText',
    placeholder: 'So, are you in?',
    maxLength: 2000,
    rendersTokens: true,
    showsMentions: true,
};

/** As Open Ticket declares its reason. */
const REASON: LongTextField = {
    key: 'reason',
    label: 'Reason',
    control: 'longText',
    maxLength: 1000,
    rendersTokens: true,
    showsMentions: true,
};

/** As Send DM declares its message: no mentions — a DM is outside the server. */
const DM_MESSAGE: LongTextField = {
    key: 'message',
    label: 'Message',
    control: 'longText',
    maxLength: 2000,
    rendersTokens: true,
};

const VERIFIED: GuildRole = { id: '222222222222222222', name: 'Verified', color: 0xe74c3c, position: 3, owner: null };
const BOOSTER: ManagedRole = { id: '555555555555555555', name: 'Server Booster', color: 0xf47fff, position: 4 };
const LOUNGE: GuildChannel = { id: '700000000000000000', name: 'Lounge', type: 'category', parentId: null, parentName: null, owner: null };
const GENERAL: GuildChannel = {
    id: '710000000000000000',
    name: 'general',
    type: 'text',
    parentId: LOUNGE.id,
    parentName: LOUNGE.name,
    owner: null,
};

const TICKET_CHANNEL: AvailableVariable = {
    name: 'ticketChannelId',
    producerLabel: 'Open Ticket',
    producerIcon: '🎫',
    valueKind: 'channel',
};

const CONTEXT: ControlContext = {
    roles: [VERIFIED],
    managedRoles: [BOOSTER],
    channels: [LOUNGE, GENERAL],
    ticketTypes: [],
    variables: [TICKET_CHANNEL],
    requirements: ALL_REQUIREMENTS_AVAILABLE,
    declaredResources: [],
    setConfigKey: () => undefined,
    uploads: NO_UPLOADS,
    ...NO_JOURNEY,
};

/** The control on a node whose value follows its own `onChange`, recording every value it emits. */
function Harness({ field, initial, emitted }: { field: LongTextField; initial: string; emitted: unknown[] }) {
    const [value, setValue] = useState<unknown>(initial);
    return (
        <LongTextControl
            field={field}
            value={value}
            onChange={(next) => {
                emitted.push(next);
                setValue(next);
            }}
            context={CONTEXT}
        />
    );
}

describe('a long text box whose text shows mentions', () => {
    it.each([QUESTION, REASON])('offers channels on # and roles on @ in $label, written as Discord reads them', async (field) => {
        const emitted: unknown[] = [];
        const { user } = renderWithProviders(<Harness field={field} initial="" emitted={emitted} />);
        const box = screen.getByRole('textbox', { name: field.label });

        await user.type(box, 'Head to #');
        // Text channels only: a category is somewhere nobody posts.
        expect(screen.getByRole('option', { name: /^#general/ })).toBeTruthy();
        expect(screen.queryByRole('option', { name: /^#Lounge/ })).toBeNull();
        await user.click(screen.getByRole('option', { name: /^#general/ }));
        expect(emitted.at(-1)).toBe(`Head to <#${GENERAL.id}> `);
        expect((box as HTMLTextAreaElement).value).toBe('Head to #general ');

        // Managed roles too, as the message window offers them.
        await user.type(box, '@boo');
        await user.click(screen.getByRole('option', { name: 'Server Booster' }));
        expect(emitted.at(-1)).toBe(`Head to <#${GENERAL.id}> <@&${BOOSTER.id}> `);
        expect((box as HTMLTextAreaElement).value).toBe('Head to #general @Server Booster ');
    });

    it('shows a stored mention by name, and an unknown one as such', () => {
        renderWithProviders(
            <Harness field={QUESTION} initial={`Ask <@&${VERIFIED.id}> in <#${GENERAL.id}> or <#999999999999999999>`} emitted={[]} />
        );

        const box = screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement;
        expect(box.value).toBe('Ask @Verified in #general or #unknown-channel');
        // Described by its limit hint, as the plain box is.
        const describedBy = box.getAttribute('aria-describedby') ?? '';
        expect(document.getElementById(describedBy)?.textContent).toMatch(/Up to 2000 characters/);
    });

    it('shuts a list on Escape, leaving what was typed', async () => {
        const emitted: unknown[] = [];
        const { user } = renderWithProviders(<Harness field={QUESTION} initial="" emitted={emitted} />);
        const box = screen.getByRole('textbox', { name: 'Question' });

        await user.type(box, '#');
        expect(screen.getByRole('option', { name: /^#general/ })).toBeTruthy();
        // The list reads `keyCode`, which every browser sets and user-event's keys leave out.
        fireEvent.keyDown(box, { key: 'Escape', code: 'Escape', keyCode: 27 });
        expect(screen.queryByRole('option', { name: /^#general/ })).toBeNull();
        expect(emitted.at(-1)).toBe('#');
    });

    it('draws mentions by name in the token preview too', async () => {
        renderWithProviders(
            <Harness field={QUESTION} initial={`Room: <#{{var.ticketChannelId}}>, ask <#${GENERAL.id}>`} emitted={[]} />
        );

        // The token is filled in by the preview's stand-in; the real channel is named.
        expect(screen.getByText(/Preview:/).parentElement?.textContent).toBe('Preview: Room: <#[ticketChannelId]>, ask #general');
    });
});

describe("a long text box whose text doesn't show mentions", () => {
    it("is Send DM's plain box: @ and # offer nothing and are written as typed", async () => {
        const emitted: unknown[] = [];
        const { user } = renderWithProviders(<Harness field={DM_MESSAGE} initial="" emitted={emitted} />);
        const box = screen.getByRole('textbox', { name: 'Message' });

        await user.type(box, 'Hi @ver #gen');
        expect(screen.queryByRole('option')).toBeNull();
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(emitted.at(-1)).toBe('Hi @ver #gen');
    });
});
