import { StrictMode, useState, type ReactElement } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BlockConfigField, DiscordMessage, GuildUpload, ListGuildUploadsResponse } from '@brattybot/web-sdk';
import { heldReply, installFakeApi } from '../../../__tests__/support/fakeApi';
import { NO_JOURNEY } from '../../../__tests__/support/noJourney';
import { NO_UPLOADS } from '../../../__tests__/support/noUploads';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { MessageControl } from '../../controls/MessageControl';
import type { ControlContext, GuildUploads, NestedIssue } from '../../controls/types';
import { useGuildUploads } from '../../useGuildUploads';
import { ALL_REQUIREMENTS_AVAILABLE } from '../../variables';

/**
 * The message window, driven the way an author drives it: open it from the inspector, click a
 * part, type. The control is held in real state, so every edit lands on the message the last
 * one made — as it does on the page — and every value it emits is recorded.
 */

const FIELD: Extract<BlockConfigField, { control: 'message' }> = {
    key: 'message',
    label: 'Message',
    control: 'message',
    swatches: ['#00A2FF', '#FF2D95'],
};

const GUILD_ID = '111111111111111111';
const UPLOAD_ID = '7d4f3b52-9a51-4a7b-8f53-0f6c5b0d2c11';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function deepFreeze<TValue>(value: TValue): TValue {
    if (value !== null && typeof value === 'object') {
        for (const inner of Object.values(value)) deepFreeze(inner);
        Object.freeze(value);
    }
    return value;
}

function contextWith(uploads: GuildUploads): ControlContext {
    return {
        roles: [],
        channels: [],
        ticketTypes: [],
        variables: [],
        requirements: ALL_REQUIREMENTS_AVAILABLE,
        declaredResources: [],
        setConfigKey: () => undefined,
        uploads,
        ...NO_JOURNEY,
    };
}

interface HarnessProps {
    readonly initial: unknown;
    readonly emitted: (DiscordMessage | undefined)[];
    readonly issues?: readonly NestedIssue[];
    readonly uploads?: GuildUploads;
}

/** The control on a node whose value follows its own `onChange`, as the inspector's does. */
function Harness({ initial, emitted, issues, uploads = NO_UPLOADS }: HarnessProps) {
    const [value, setValue] = useState<unknown>(initial);
    return (
        <MessageControl
            field={FIELD}
            value={value}
            onChange={(next) => {
                const message = next as DiscordMessage | undefined;
                emitted.push(message);
                setValue(message);
            }}
            context={contextWith(uploads)}
            issues={issues}
        />
    );
}

/** The same, with the page's real uploads hook, so an upload goes out through the SDK. */
function UploadingHarness(props: Omit<HarnessProps, 'uploads'>) {
    return <Harness {...props} uploads={useGuildUploads(GUILD_ID)} />;
}

/**
 * Rendered under StrictMode, as `main.tsx` renders the app: effects mount, clean up and mount
 * again, so state kept in a ref across that — the window once thought it had closed the
 * moment it opened, and took no edits at all in `pnpm dev` — fails here rather than only
 * in the browser.
 */
function renderStrict(ui: ReactElement) {
    return renderWithProviders(<StrictMode>{ui}</StrictMode>);
}

async function openWindow(options: HarnessProps) {
    const rendered = renderStrict(<Harness {...options} />);
    await rendered.user.click(screen.getByRole('button', { name: 'Edit message' }));
    return rendered;
}

const last = (emitted: readonly (DiscordMessage | undefined)[]) => emitted.at(-1);

describe('editing a part in place', () => {
    it('turns the title into a text box on a click, and emits a new message per keystroke', async () => {
        const initial = deepFreeze<DiscordMessage>({ embeds: [{ title: 'House rules', color: '#00A2FF' }] });
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial, emitted });

        await user.click(screen.getByRole('button', { name: 'Embed 1 title' }));
        await user.type(screen.getByRole('textbox', { name: 'Embed 1 title' }), '!');

        expect(last(emitted)).toEqual({ embeds: [{ title: 'House rules!', color: '#00A2FF' }] });
        expect(last(emitted)).not.toBe(initial);
        expect(initial).toEqual({ embeds: [{ title: 'House rules', color: '#00A2FF' }] });
        // The count, from the generated contract's own limit.
        expect(screen.getByText('12 / 256')).toBeTruthy();
    });

    it('leaves a cleared part out of the message, rather than writing it empty', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial: { embeds: [{ title: 'T', description: 'Body' }] }, emitted });

        await user.click(screen.getByRole('button', { name: 'Embed 1 body' }));
        await user.clear(screen.getByRole('textbox', { name: 'Embed 1 body' }));

        expect(last(emitted)).toEqual({ embeds: [{ title: 'T' }] });
        expect(Object.keys(last(emitted)?.embeds[0] ?? {})).not.toContain('description');
    });

    it('appends a token from {x}, and keeps the part open to go on typing', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial: { embeds: [{ title: 'Welcome' }] }, emitted });

        await user.click(screen.getByRole('button', { name: 'Embed 1 title' }));
        await user.click(screen.getByRole('button', { name: 'Insert a token into embed 1 title' }));
        await user.click(screen.getByRole('button', { name: 'subject.displayName' }));

        expect(last(emitted)).toEqual({ embeds: [{ title: 'Welcome {{subject.displayName}}' }] });
        const box = screen.getByRole('textbox', { name: 'Embed 1 title' });
        expect(document.activeElement).toBe(box);
        await user.type(box, '!');
        expect(last(emitted)).toEqual({ embeds: [{ title: 'Welcome {{subject.displayName}}!' }] });
    });

    it('keeps the part open while Tab moves on to its {x}, and closes it once focus leaves the part', async () => {
        const { user } = await openWindow({ initial: { embeds: [{ title: 'Welcome' }] }, emitted: [] });

        await user.click(screen.getByRole('button', { name: 'Embed 1 title' }));
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Insert a token into embed 1 title' }));
        expect(screen.getByRole('textbox', { name: 'Embed 1 title' })).toBeTruthy();

        await user.tab();
        expect(screen.queryByRole('textbox', { name: 'Embed 1 title' })).toBeNull();
    });

    it('starts a node with no message on one embed in the first swatch, written by the first edit', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial: undefined, emitted });
        expect(emitted).toEqual([]);

        await user.click(screen.getByRole('button', { name: 'Embed 1 title' }));
        await user.type(screen.getByRole('textbox', { name: 'Embed 1 title' }), 'Hi');

        expect(last(emitted)).toEqual({ embeds: [{ color: '#00A2FF', title: 'Hi' }] });
    });
});

describe('the embeds', () => {
    it('adds, duplicates, moves and deletes them, and hides Add at the tenth', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial: { embeds: [{ title: 'A' }] }, emitted });
        const titles = () => last(emitted)?.embeds.map((embed) => embed.title ?? embed.color);

        await user.click(screen.getByRole('button', { name: 'Add embed' }));
        expect(last(emitted)?.embeds).toEqual([{ title: 'A' }, { color: '#00A2FF' }]);

        await user.click(screen.getByRole('button', { name: 'Duplicate embed 1' }));
        expect(titles()).toEqual(['A', 'A', '#00A2FF']);

        await user.click(screen.getByRole('button', { name: 'Move embed 3 up' }));
        expect(titles()).toEqual(['A', '#00A2FF', 'A']);

        await user.click(screen.getByRole('button', { name: 'Delete embed 1' }));
        expect(titles()).toEqual(['#00A2FF', 'A']);

        for (let count = 2; count < 10; count += 1) {
            await user.click(screen.getByRole('button', { name: 'Add embed' }));
        }
        expect(last(emitted)?.embeds).toHaveLength(10);
        expect(screen.queryByRole('button', { name: 'Add embed' })).toBeNull();
        expect(screen.getByText(/10 of 10/)).toBeTruthy();
    });
});

describe("the server's complaints", () => {
    it('marks the part a complaint names, and counts it in the inspector', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const issues = [{ path: 'embeds.0.title', message: 'Titles stop at 256 characters.' }];
        const { user } = renderStrict(
            <Harness initial={{ embeds: [{ title: 'x'.repeat(300) }] }} emitted={emitted} issues={issues} />
        );

        expect(screen.getByText('1 problem in this message')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Edit message' }));
        const title = screen.getByRole('button', { name: 'Embed 1 title' });
        expect(title.getAttribute('data-problem')).toBe('true');
        expect(screen.getByText('Titles stop at 256 characters.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Embed 1 body' }).getAttribute('data-problem')).toBeNull();
    });
});

describe('Cancel', () => {
    it('puts back the message as it was when the window opened, with one change', async () => {
        const initial = { embeds: [{ title: 'Before', fields: [{ name: 'A', value: 'B', inline: false }] }] };
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial, emitted });

        await user.click(screen.getByRole('button', { name: 'Embed 1 title' }));
        await user.type(screen.getByRole('textbox', { name: 'Embed 1 title' }), ' and after');
        const edits = emitted.length;
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(emitted).toHaveLength(edits + 1);
        expect(last(emitted)).toEqual(initial);
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
        expect(screen.getByText('Before')).toBeTruthy();
    });

    it('takes the message away again on a node that had none', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial: undefined, emitted });

        await user.click(screen.getByRole('button', { name: 'Add embed' }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(last(emitted)).toBeUndefined();
    });

    it('changes nothing when nothing was changed', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial: { embeds: [{ title: 'Same' }] }, emitted });

        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(emitted).toEqual([]);
    });
});

describe('Escape', () => {
    it('finishes the part being typed into, then closes a popover, and only then the window — keeping the changes', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({ initial: { embeds: [{ title: 'A' }] }, emitted });

        await user.click(screen.getByRole('button', { name: 'Embed 1 title' }));
        await user.type(screen.getByRole('textbox', { name: 'Embed 1 title' }), 'B');
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('textbox', { name: 'Embed 1 title' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
        // Focus goes back to the part, not to the page.
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Embed 1 title' }));

        await user.click(screen.getByRole('button', { name: 'Embed 1 thumbnail' }));
        expect(screen.getByText('Already uploaded to this server')).toBeTruthy();
        await user.click(screen.getByText('Link'));
        await user.click(screen.getByRole('textbox', { name: 'Picture link' }));
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Picture link' })).toBeNull());
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Embed 1 thumbnail' })));

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
        expect(last(emitted)).toEqual({ embeds: [{ title: 'AB' }] });
    });
});

describe('Preview', () => {
    it('fills tokens with stand-ins, and shows a face for a picture only a run can fill', async () => {
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = await openWindow({
            initial: { embeds: [{ title: 'Hey {{subject.mention}}', thumbnail: '{{subject.avatarUrl}}' }] },
            emitted,
        });

        await user.click(screen.getByText('Preview'));

        expect(screen.getByText('@someone')).toBeTruthy();
        expect(screen.getByRole('img', { name: 'A stand-in face, filled in when the flow runs' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Embed 1 title' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add embed' })).toBeNull();
    });
});

describe('uploading a picture', () => {
    const kept: GuildUpload = {
        uploadId: UPLOAD_ID,
        fileName: 'collar.png',
        contentType: 'image/png',
        byteSize: PNG_BYTES.length,
        createdAt: '2026-10-24T00:00:00.000Z',
        uploadedBy: '100000000000000001',
    };

    /** The server's list before anything is uploaded. */
    const NO_UPLOADS_LISTED: ListGuildUploadsResponse = { uploads: [], totalBytes: 0, limitBytes: 200 * 1024 * 1024 };

    function picture(): File {
        return new File([PNG_BYTES], 'collar.png', { type: 'image/png' });
    }

    it('sends the bytes through the API and sets the part to the upload', async () => {
        const api = installFakeApi();
        api.on('GET', `/api/guilds/${GUILD_ID}/uploads`, () => ({ body: NO_UPLOADS_LISTED }));
        api.on('POST', `/api/guilds/${GUILD_ID}/uploads?name=collar.png`, () => ({ status: 201, body: kept }));
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = renderStrict(<UploadingHarness initial={{ embeds: [{ title: 'A' }] }} emitted={emitted} />);
        await user.click(screen.getByRole('button', { name: 'Edit message' }));

        await user.click(screen.getByRole('button', { name: 'Embed 1 footer icon' }));
        await user.upload(screen.getByLabelText('Upload a picture'), picture());

        await waitFor(() => expect(last(emitted)).toEqual({ embeds: [{ title: 'A', footer: { iconUrl: `upload:${UPLOAD_ID}` } }] }));
        const sent = api.requests.find((request) => request.method === 'POST');
        expect(sent?.body).toEqual(PNG_BYTES);
        // And it is offered again at once, without reading the list over.
        expect(await screen.findByRole('button', { name: 'Use collar.png' })).toBeTruthy();
    });

    it("shows the server's refusal in its own words", async () => {
        const api = installFakeApi();
        api.on('GET', `/api/guilds/${GUILD_ID}/uploads`, () => ({ body: NO_UPLOADS_LISTED }));
        api.on('POST', `/api/guilds/${GUILD_ID}/uploads?name=collar.png`, () => ({
            status: 415,
            body: { error: "PNG, JPG, GIF or WebP only — that's none of them." },
        }));
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = renderStrict(<UploadingHarness initial={{ embeds: [{ title: 'A' }] }} emitted={emitted} />);
        await user.click(screen.getByRole('button', { name: 'Edit message' }));

        await user.click(screen.getByRole('button', { name: 'Embed 1 image' }));
        await user.upload(screen.getByLabelText('Upload a picture'), picture());

        expect(await screen.findByText("PNG, JPG, GIF or WebP only — that's none of them.")).toBeTruthy();
        expect(emitted).toEqual([]);
    });

    it('refuses a picture over the cap without sending it, as the Uploads page does', async () => {
        const api = installFakeApi();
        api.on('GET', `/api/guilds/${GUILD_ID}/uploads`, () => ({ body: NO_UPLOADS_LISTED }));
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = renderStrict(<UploadingHarness initial={{ embeds: [{ title: 'A' }] }} emitted={emitted} />);
        await user.click(screen.getByRole('button', { name: 'Edit message' }));

        await user.click(screen.getByRole('button', { name: 'Embed 1 image' }));
        await user.upload(
            screen.getByLabelText('Upload a picture'),
            new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })
        );

        expect(await screen.findByText('huge.png is a bit too much, even for me. 8 MB or less, please.')).toBeTruthy();
        expect(api.requests.filter((request) => request.method === 'POST')).toEqual([]);
        expect(emitted).toEqual([]);
    });

    it('never disables an input while the upload is on its way', async () => {
        const api = installFakeApi();
        const held = heldReply();
        api.on('GET', `/api/guilds/${GUILD_ID}/uploads`, () => ({ body: NO_UPLOADS_LISTED }));
        api.on('POST', `/api/guilds/${GUILD_ID}/uploads?name=collar.png`, () => held.reply);
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = renderStrict(<UploadingHarness initial={{ embeds: [{ title: 'A' }] }} emitted={emitted} />);
        await user.click(screen.getByRole('button', { name: 'Edit message' }));

        await user.click(screen.getByRole('button', { name: 'Embed 1 thumbnail' }));
        await user.upload(screen.getByLabelText('Upload a picture'), picture());
        expect(await screen.findByText('Uploading collar.png…')).toBeTruthy();

        // Every box and button, in the window and in the picture's box alike — the upload tab
        // with its drop zone and browse, then the link tab's box.
        const disabledControls = () =>
            [...document.querySelectorAll<HTMLElement>('input, textarea, button, select, fieldset')]
                .filter((control) => control.hasAttribute('disabled'))
                .map((control) => control.outerHTML);
        expect(document.querySelectorAll('input, textarea, button').length).toBeGreaterThan(10);
        expect(disabledControls()).toEqual([]);
        await user.click(screen.getByText('Link'));
        expect(screen.getByRole('textbox', { name: 'Picture link' })).toBeTruthy();
        expect(disabledControls()).toEqual([]);

        // And the author can keep typing elsewhere while it goes.
        await user.click(screen.getByRole('button', { name: 'Embed 1 body' }));
        expect(disabledControls()).toEqual([]);
        await user.type(screen.getByRole('textbox', { name: 'Embed 1 body' }), 'Still here');
        expect(last(emitted)?.embeds[0]?.description).toBe('Still here');

        held.send({ status: 201, body: kept });
        await waitFor(() => expect(last(emitted)?.embeds[0]?.thumbnail).toBe(`upload:${UPLOAD_ID}`));
        // Landed on top of the typing, not over it.
        expect(last(emitted)?.embeds[0]?.description).toBe('Still here');
    });

    it('holds the tools that renumber the embeds until the upload lands, so it lands on its own embed', async () => {
        const api = installFakeApi();
        const held = heldReply();
        api.on('GET', `/api/guilds/${GUILD_ID}/uploads`, () => ({ body: NO_UPLOADS_LISTED }));
        api.on('POST', `/api/guilds/${GUILD_ID}/uploads?name=collar.png`, () => held.reply);
        const emitted: (DiscordMessage | undefined)[] = [];
        const { user } = renderStrict(<UploadingHarness initial={{ embeds: [{ title: 'A' }, { title: 'B' }] }} emitted={emitted} />);
        await user.click(screen.getByRole('button', { name: 'Edit message' }));

        await user.click(screen.getByRole('button', { name: 'Embed 1 image' }));
        await user.upload(screen.getByLabelText('Upload a picture'), picture());
        expect(await screen.findByText('Uploading collar.png…')).toBeTruthy();

        const deleteFirst = screen.getByRole('button', { name: 'Delete embed 1' });
        expect(deleteFirst.getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByRole('button', { name: 'Move embed 2 up' }).getAttribute('aria-disabled')).toBe('true');
        await user.click(deleteFirst);
        expect(emitted).toEqual([]);

        held.send({ status: 201, body: kept });
        await waitFor(() => expect(last(emitted)?.embeds[0]?.image).toBe(`upload:${UPLOAD_ID}`));
        expect(screen.getByRole('button', { name: 'Delete embed 1' }).getAttribute('aria-disabled')).toBeNull();
    });
});

describe('the inspector', () => {
    it('opens the window from a preview of what is in the message', async () => {
        const { user } = renderStrict(
            <Harness
                initial={{ content: 'Hey there', embeds: [{ title: 'Welcome' }, { title: 'House rules' }] }}
                emitted={[]}
            />
        );

        expect(screen.getByText('2 embeds · plain text above')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Edit message' }));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByRole('button', { name: 'Embed 2 title' })).toBeTruthy();
    });
});
