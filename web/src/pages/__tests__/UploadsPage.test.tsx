import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { GuildUpload, GuildUploadListing, ListGuildUploadsResponse, UploadUse } from '@brattybot/web-sdk';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { heldReply, installFakeApi, type FakeApi, type HeldReply } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';

/**
 * The Uploads page in the whole app, against the fake API: the sidebar reaches it, its cards
 * say where each picture is shown, and Delete asks the server — which may know better than
 * the page did.
 *
 * Where the page patches its cached list before asking the server for it again, the follow-up
 * read is held, so what is asserted is the patch and not the server's answer over it.
 */

const GUILD_ID = '900000000000000001';
const OPERATOR_ID = '200000000000000002';
const OTHER_MOD_ID = '200000000000000003';
const UPLOADS_PATH = `/api/guilds/${GUILD_ID}/uploads`;
const MIB = 1024 * 1024;

const WELCOME_FLOW = '11111111-1111-1111-1111-111111111111';
const BIRTHDAY_FLOW = '22222222-2222-2222-2222-222222222222';
const RULES_FLOW = '33333333-3333-3333-3333-333333333333';

const LIVE_USE: UploadUse = {
    kind: 'flow',
    flowId: WELCOME_FLOW,
    flowName: 'Welcome flow',
    nodeId: 'welcome',
    blockLabel: 'Post Embed',
    where: 'embed 1 thumbnail',
};
const DRAFT_USE: UploadUse = {
    kind: 'flow',
    flowId: BIRTHDAY_FLOW,
    flowName: 'Birthday shout',
    nodeId: 'shout',
    blockLabel: 'Post Embed',
    where: 'embed 1 footer icon',
    draftAuthorId: OTHER_MOD_ID,
};

function upload(uploadId: string, fileName: string, byteSize: number, uses: readonly UploadUse[] = []): GuildUploadListing {
    return {
        uploadId,
        fileName,
        contentType: fileName.endsWith('.webp') ? 'image/webp' : 'image/png',
        byteSize,
        uploadedBy: OPERATOR_ID,
        createdAt: '2026-10-24T10:00:00.000Z',
        uses: [...uses],
    };
}

const LOGO = upload('aaaaaaaa-0000-0000-0000-000000000001', 'logo-square.webp', 340 * 1024, [LIVE_USE, DRAFT_USE]);
const OLD_HEADER = upload('aaaaaaaa-0000-0000-0000-000000000002', 'old-rules-header.png', Math.round(5.8 * MIB));
const ONE_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const TWO_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function listOf(uploads: readonly GuildUploadListing[]): ListGuildUploadsResponse {
    return {
        uploads: [...uploads],
        totalBytes: uploads.reduce((total, item) => total + item.byteSize, 0),
        limitBytes: 200 * MIB,
    };
}

/** The shell's own reads, and a server holding `uploads`. */
function serveUploads(uploads: readonly GuildUploadListing[]): FakeApi {
    const api = installFakeApi();
    api.on('GET', '/api/bot', () => ({
        body: { ready: true, id: '300000000000000003', username: 'BrattyBot', flavour: 'production' },
    }));
    api.on('GET', '/api/auth/me', () => ({ body: { id: OPERATOR_ID, username: 'velvet_admin', avatar: null } }));
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    api.on('GET', UPLOADS_PATH, () => ({ body: listOf(uploads) }));
    return api;
}

/** Hold every later read of the list, so the page's own patch is what shows until it is sent. */
function holdNextListRead(api: FakeApi): HeldReply {
    const held = heldReply();
    api.on('GET', UPLOADS_PATH, () => held.reply);
    return held;
}

function renderUploadsPage() {
    const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: ['/uploads'] });
    return renderWithProviders(<RouterProvider router={router} />);
}

const card = (fileName: string) => screen.findByRole('article', { name: fileName });
const listReads = (api: FakeApi) => api.requests.filter((request) => request.method === 'GET' && request.path === UPLOADS_PATH);
const deleteRequests = (api: FakeApi) => api.requests.filter((request) => request.method === 'DELETE');
const uploadRequests = (api: FakeApi) => api.requests.filter((request) => request.method === 'POST');
/** The meter's "N of 200 MB used" line. */
const meter = () => screen.getByText(/of 200 MB used/).textContent;

function picture(name: string, size = 64): File {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new File([bytes], name, { type: 'image/png' });
}

/** The server's answer to keeping a picture. */
function kept(uploadId: string, fileName: string): GuildUpload {
    return {
        uploadId,
        fileName,
        contentType: 'image/png',
        byteSize: 64,
        uploadedBy: OPERATOR_ID,
        createdAt: '2026-10-24T11:00:00.000Z',
    };
}

/** Drop `files` on the drop zone, carrying what a browser's file drag carries. */
function drop(files: readonly File[]): void {
    fireEvent.drop(screen.getByRole('group', { name: 'Drop pictures here' }), { dataTransfer: { files, types: ['Files'] } });
}

const batchRow = (fileName: string) =>
    within(screen.getByRole('list', { name: 'Pictures being uploaded' })).getByRole('listitem', { name: fileName });

beforeEach(() => {
    window.localStorage.clear();
});

describe('the Uploads page', () => {
    it('is in the sidebar, right after Flows', async () => {
        serveUploads([]);
        renderUploadsPage();

        const links = (await screen.findAllByRole('link')).map((link) => link.textContent?.trim() ?? '');
        const flows = links.findIndex((text) => text.startsWith('Flows'));
        expect(links[flows + 1]).toMatch(/^Uploads/);
    });

    it('shows the room used, and on each card every place the picture is shown, marking the draft-only one', async () => {
        serveUploads([LOGO, OLD_HEADER]);
        renderUploadsPage();

        const logo = await card('logo-square.webp');
        const uses = within(within(logo).getByRole('list', { name: 'Where logo-square.webp is used' })).getAllByRole('listitem');
        expect(uses).toHaveLength(2);
        expect(within(uses[0]!).getByRole('link', { name: 'Welcome flow' }).getAttribute('href')).toBe(`/flows/${WELCOME_FLOW}`);
        expect(uses[0]!.textContent).toContain('· Post Embed · embed 1 thumbnail');
        expect(within(uses[0]!).queryByText('Draft')).toBeNull();
        expect(within(uses[1]!).getByRole('link', { name: 'Birthday shout' }).getAttribute('href')).toBe(`/flows/${BIRTHDAY_FLOW}`);
        expect(within(uses[1]!).getByText('Draft')).toBeTruthy();
        // What DRAFT means, readable without hovering.
        expect(within(uses[1]!).getByText(`Only in an unsaved draft of this flow, by ${OTHER_MOD_ID}.`)).toBeTruthy();
        expect(within(logo).getByText(/340 KB · you ·/)).toBeTruthy();

        const header = await card('old-rules-header.png');
        expect(within(header).getByText('● Not used anywhere')).toBeTruthy();
        expect(meter()).toBe('6.1 MB of 200 MB used');
    });

    it("shows a journey's message as a use, linking to the flows page where its resources are edited", async () => {
        const journeyUse: UploadUse = {
            kind: 'journeyMessage',
            journeyKey: 'onboarding',
            journeyName: 'Onboarding',
            resourceKey: 'rules-panel',
            messageName: 'Rules panel',
            where: 'embed 1 image',
        };
        serveUploads([{ ...OLD_HEADER, uses: [journeyUse] }]);
        renderUploadsPage();

        const header = await card('old-rules-header.png');
        const [use] = within(within(header).getByRole('list', { name: 'Where old-rules-header.png is used' })).getAllByRole('listitem');
        expect(within(use!).getByRole('link', { name: 'Onboarding' }).getAttribute('href')).toBe('/flows');
        expect(use!.textContent).toBe('Onboarding · message Rules panel · embed 1 image');
        expect(within(use!).queryByText('Draft')).toBeNull();
    });

    it('filters to the pictures in use, and to the ones nothing uses', async () => {
        serveUploads([LOGO, OLD_HEADER]);
        const { user } = renderUploadsPage();
        await card('logo-square.webp');

        await user.click(screen.getByRole('radio', { name: 'In use' }));
        expect(screen.queryByRole('article', { name: 'old-rules-header.png' })).toBeNull();
        expect(screen.getByRole('article', { name: 'logo-square.webp' })).toBeTruthy();

        await user.click(screen.getByRole('radio', { name: 'Unused' }));
        expect(screen.queryByRole('article', { name: 'logo-square.webp' })).toBeNull();
        expect(screen.getByRole('article', { name: 'old-rules-header.png' })).toBeTruthy();

        await user.click(screen.getByRole('radio', { name: 'All' }));
        expect(screen.getAllByRole('article')).toHaveLength(2);
    });

    it('says so when the server has no pictures at all', async () => {
        serveUploads([]);
        renderUploadsPage();

        expect(await screen.findByText('No pictures yet')).toBeTruthy();
    });
});

describe('deleting a picture', () => {
    it('deletes one nothing uses: off the page and the meter at once, focus on the heading', async () => {
        const api = serveUploads([LOGO, OLD_HEADER]);
        api.on('DELETE', `${UPLOADS_PATH}/${OLD_HEADER.uploadId}`, () => ({ status: 204 }));
        const { user } = renderUploadsPage();

        await user.click(within(await card('old-rules-header.png')).getByRole('button', { name: 'Delete old-rules-header.png' }));
        const dialog = await screen.findByRole('dialog', { name: 'Delete old-rules-header.png?' });
        expect(within(dialog).getByText(/Messages the bot already posted keep their copy/)).toBeTruthy();
        const reread = holdNextListRead(api);
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

        // Before the server's list comes back: the page's own patch.
        await waitFor(() => expect(screen.queryByRole('article', { name: 'old-rules-header.png' })).toBeNull());
        expect(meter()).toBe('340 KB of 200 MB used');
        expect(screen.queryByRole('dialog')).toBeNull();
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Uploads', level: 1 })));

        reread.send({ body: listOf([LOGO]) });
        await waitFor(() => expect(listReads(api)).toHaveLength(2));
        expect(screen.getByRole('article', { name: 'logo-square.webp' })).toBeTruthy();
        expect(deleteRequests(api)).toHaveLength(1);
    });

    it('refuses up front for one in use, listing every place, and sends nothing', async () => {
        const api = serveUploads([LOGO, OLD_HEADER]);
        const { user } = renderUploadsPage();

        const opener = within(await card('logo-square.webp')).getByRole('button', { name: 'Delete logo-square.webp' });
        await user.click(opener);
        const dialog = await screen.findByRole('dialog', { name: "Can't delete logo-square.webp" });

        const uses = within(within(dialog).getByRole('list', { name: 'Where logo-square.webp is used' })).getAllByRole('listitem');
        expect(uses.map((use) => use.textContent)).toEqual([
            expect.stringContaining('Welcome flow'),
            expect.stringContaining('Birthday shout'),
        ]);
        expect(within(uses[1]!).getByText('Draft')).toBeTruthy();
        expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull();

        await user.click(within(dialog).getByRole('button', { name: 'Close' }));
        // Back where it was opened from, since the picture is still there.
        await waitFor(() => expect(document.activeElement).toBe(opener));
        expect(deleteRequests(api)).toHaveLength(0);
    });

    it("shows the server's places when it refuses one the page thought unused, and keeps focus in the dialog", async () => {
        const api = serveUploads([LOGO, OLD_HEADER]);
        const rulesUse: UploadUse = {
            kind: 'flow',
            flowId: RULES_FLOW,
            flowName: 'Rules reminder',
            nodeId: 'remind',
            blockLabel: 'Post Embed',
            where: 'embed 2 image',
        };
        api.on('DELETE', `${UPLOADS_PATH}/${OLD_HEADER.uploadId}`, () => ({
            status: 409,
            body: { error: "Not so fast — that picture's still on display.", uses: [rulesUse] },
        }));
        const { user } = renderUploadsPage();

        await user.click(within(await card('old-rules-header.png')).getByRole('button', { name: 'Delete old-rules-header.png' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

        const dialog = await screen.findByRole('dialog', { name: "Can't delete old-rules-header.png" });
        expect(within(dialog).getByRole('alert').textContent).toBe("Not so fast — that picture's still on display.");
        const uses = within(dialog).getByRole('list', { name: 'Where old-rules-header.png is used' });
        expect(within(uses).getByRole('link', { name: 'Rules reminder' }).getAttribute('href')).toBe(`/flows/${RULES_FLOW}`);
        expect(uses.textContent).toContain('· Post Embed · embed 2 image');
        // The focused Delete went with the confirm view; focus is on the refusal's Close, not the page.
        await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' })));
        expect(dialog.contains(document.activeElement)).toBe(true);
        // The page's list was out of date, so it asks again.
        await waitFor(() => expect(listReads(api)).toHaveLength(2));
    });

    it("takes a 404 for a picture somebody already deleted as done, and drops it from the page", async () => {
        const api = serveUploads([LOGO, OLD_HEADER]);
        api.on('DELETE', `${UPLOADS_PATH}/${OLD_HEADER.uploadId}`, () => ({
            status: 404,
            body: { error: "That picture isn't in this server." },
        }));
        const { user } = renderUploadsPage();

        await user.click(within(await card('old-rules-header.png')).getByRole('button', { name: 'Delete old-rules-header.png' }));
        holdNextListRead(api);
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

        expect(await screen.findByText('Already gone')).toBeTruthy();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('article', { name: 'old-rules-header.png' })).toBeNull();
    });

    it('shows any other 404 as an error and leaves the dialog open', async () => {
        const api = serveUploads([LOGO, OLD_HEADER]);
        api.on('DELETE', `${UPLOADS_PATH}/${OLD_HEADER.uploadId}`, () => ({ status: 404, body: { error: 'Server not found.' } }));
        const { user } = renderUploadsPage();

        await user.click(within(await card('old-rules-header.png')).getByRole('button', { name: 'Delete old-rules-header.png' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

        const dialog = await screen.findByRole('dialog', { name: 'Delete old-rules-header.png?' });
        expect(await within(dialog).findByText('Server not found.')).toBeTruthy();
        expect(screen.queryByText('Already gone')).toBeNull();
    });

    it('disables nothing while the delete is on its way, and takes no second one', async () => {
        const api = serveUploads([LOGO, OLD_HEADER]);
        const answer = heldReply();
        api.on('DELETE', `${UPLOADS_PATH}/${OLD_HEADER.uploadId}`, () => answer.reply);
        const { user, container } = renderUploadsPage();

        await user.click(within(await card('old-rules-header.png')).getByRole('button', { name: 'Delete old-rules-header.png' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await within(dialog).findByRole('button', { name: 'Deleting…' });
        await user.click(within(dialog).getByRole('button', { name: 'Deleting…' }));

        expect(container.querySelectorAll('[disabled]')).toHaveLength(0);
        expect(deleteRequests(api)).toHaveLength(1);

        holdNextListRead(api);
        answer.send({ status: 204 });
        await waitFor(() => expect(screen.queryByRole('article', { name: 'old-rules-header.png' })).toBeNull());
    });
});

describe('uploading pictures', () => {
    it('sends several dropped pictures one after another, each showing where it has got to', async () => {
        const api = serveUploads([]);
        const first = heldReply();
        api.on('POST', `${UPLOADS_PATH}?name=one.png`, () => first.reply);
        api.on('POST', `${UPLOADS_PATH}?name=two.png`, () => ({ status: 201, body: kept(TWO_ID, 'two.png') }));
        api.on('POST', `${UPLOADS_PATH}?name=three.png`, () => ({
            status: 415,
            body: { error: "PNG, JPG, GIF or WebP only — that's none of them." },
        }));
        renderUploadsPage();
        await screen.findByText('No pictures yet');

        drop([picture('one.png'), picture('two.png'), picture('three.png')]);

        await within(batchRow('one.png')).findByText('Uploading…');
        expect(within(batchRow('two.png')).getByText('Waiting its turn')).toBeTruthy();
        // One at a time: the second is not sent while the first is out.
        expect(uploadRequests(api)).toHaveLength(1);

        const reread = holdNextListRead(api);
        first.send({ status: 201, body: kept(ONE_ID, 'one.png') });

        await within(batchRow('three.png')).findByText("PNG, JPG, GIF or WebP only — that's none of them.");
        expect(within(batchRow('one.png')).getByText('Kept')).toBeTruthy();
        expect(within(batchRow('two.png')).getByText('Kept')).toBeTruthy();
        expect(uploadRequests(api).map((request) => request.path)).toEqual([
            `${UPLOADS_PATH}?name=one.png`,
            `${UPLOADS_PATH}?name=two.png`,
            `${UPLOADS_PATH}?name=three.png`,
        ]);
        // Before the server's list comes back: the page's own patch, newest first, bytes added.
        await waitFor(() => expect(screen.getAllByRole('article').map((article) => article.getAttribute('aria-label'))).toEqual(['two.png', 'one.png']));
        expect(meter()).toBe('128 bytes of 200 MB used');

        reread.send({ body: listOf([upload(TWO_ID, 'two.png', 64), upload(ONE_ID, 'one.png', 64)]) });
        await waitFor(() => expect(listReads(api)).toHaveLength(2));
    });

    it('disables nothing while an upload is on its way', async () => {
        const api = serveUploads([LOGO, OLD_HEADER]);
        const answer = heldReply();
        api.on('POST', `${UPLOADS_PATH}?name=one.png`, () => answer.reply);
        const { container } = renderUploadsPage();
        await card('logo-square.webp');

        drop([picture('one.png')]);
        await within(batchRow('one.png')).findByText('Uploading…');

        // The filter, every card's Delete, browse and Clear are all there, and none is disabled.
        expect(screen.getByRole('radio', { name: 'Unused' })).toBeTruthy();
        expect(screen.getAllByRole('button', { name: /^Delete / })).toHaveLength(2);
        expect(screen.getByRole('button', { name: /^Clear finished uploads/ })).toBeTruthy();
        expect(container.querySelectorAll('[disabled]')).toHaveLength(0);

        holdNextListRead(api);
        answer.send({ status: 201, body: kept(ONE_ID, 'one.png') });
        await within(batchRow('one.png')).findByText('Kept');
    });

    it('puts a picture dropped mid-batch at the end, and sends it once', async () => {
        const api = serveUploads([]);
        const first = heldReply();
        api.on('POST', `${UPLOADS_PATH}?name=one.png`, () => first.reply);
        api.on('POST', `${UPLOADS_PATH}?name=two.png`, () => ({ status: 201, body: kept(TWO_ID, 'two.png') }));
        renderUploadsPage();
        await screen.findByText('No pictures yet');

        drop([picture('one.png')]);
        await within(batchRow('one.png')).findByText('Uploading…');
        drop([picture('two.png')]);
        expect(within(batchRow('two.png')).getByText('Waiting its turn')).toBeTruthy();
        expect(uploadRequests(api)).toHaveLength(1);

        holdNextListRead(api);
        first.send({ status: 201, body: kept(ONE_ID, 'one.png') });

        await within(batchRow('two.png')).findByText('Kept');
        expect(uploadRequests(api).map((request) => request.path)).toEqual([
            `${UPLOADS_PATH}?name=one.png`,
            `${UPLOADS_PATH}?name=two.png`,
        ]);
    });

    it('says when the server already had the picture, under the name it kept', async () => {
        const api = serveUploads([LOGO]);
        api.on('POST', `${UPLOADS_PATH}?name=logo-again.webp`, () => ({
            status: 200,
            body: { ...LOGO, uses: undefined },
        }));
        renderUploadsPage();
        await card('logo-square.webp');

        drop([new File([new Uint8Array(64)], 'logo-again.webp', { type: 'image/webp' })]);

        expect(await within(batchRow('logo-again.webp')).findByText('Already had this one, as logo-square.webp')).toBeTruthy();
        expect(screen.getAllByRole('article')).toHaveLength(1);
    });

    it('takes several picked through browse', async () => {
        const api = serveUploads([]);
        api.on('POST', `${UPLOADS_PATH}?name=one.png`, () => ({ status: 201, body: kept(ONE_ID, 'one.png') }));
        api.on('POST', `${UPLOADS_PATH}?name=two.png`, () => ({ status: 201, body: kept(TWO_ID, 'two.png') }));
        const { user } = renderUploadsPage();
        await screen.findByText('No pictures yet');

        await user.upload(screen.getByLabelText('Upload pictures'), [picture('one.png'), picture('two.png')]);

        await waitFor(() => expect(uploadRequests(api)).toHaveLength(2));
    });

    it('refuses a picture over the cap without sending it', async () => {
        const api = serveUploads([]);
        renderUploadsPage();
        await screen.findByText('No pictures yet');

        drop([picture('huge.png', 8 * MIB + 1)]);

        expect(await screen.findByText('huge.png is a bit too much, even for me. 8 MB or less, please.')).toBeTruthy();
        expect(uploadRequests(api)).toHaveLength(0);
    });

    it('keeps a file dropped beside the zone from replacing the page, and leaves other drags alone', async () => {
        serveUploads([]);
        const { unmount } = renderUploadsPage();
        await screen.findByText('No pictures yet');

        // `fireEvent` answers false when the event's default was prevented.
        expect(fireEvent.drop(document.body, { dataTransfer: { files: [picture('stray.png')], types: ['Files'] } })).toBe(false);
        expect(fireEvent.dragOver(document.body, { dataTransfer: { types: ['Files'] } })).toBe(false);
        expect(fireEvent.drop(document.body, { dataTransfer: { types: ['text/plain'] } })).toBe(true);

        unmount();
        expect(fireEvent.drop(document.body, { dataTransfer: { files: [picture('stray.png')], types: ['Files'] } })).toBe(true);
    });

    it('moves focus to browse when Clear empties the list', async () => {
        const api = serveUploads([]);
        api.on('POST', `${UPLOADS_PATH}?name=one.png`, () => ({ status: 201, body: kept(ONE_ID, 'one.png') }));
        const { user } = renderUploadsPage();
        await screen.findByText('No pictures yet');

        drop([picture('one.png')]);
        await within(batchRow('one.png')).findByText('Kept');
        await user.click(screen.getByRole('button', { name: 'Clear finished uploads' }));

        expect(screen.queryByRole('listitem', { name: 'one.png' })).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'browse' }));
    });
});
