import { screen, waitFor, within } from '@testing-library/react';
import type { PermissionsString } from 'discord.js';
import type { ResourceDeclaration } from '@brattybot/web-sdk';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { gradientPng } from './preview/scenario/gradientPng';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * A journey's message, end to end: declared in the builder's resources dialog — a channel,
 * then a message in it with an uploaded picture and two buttons — installed through the
 * wizard, held by TestDiscord, edited in the builder, found out of date by the flows list's
 * drift check, repaired in place, and deleted by the uninstall.
 *
 * Each layer has its own suite. What only this run shows is that the picture the window
 * picked is the file Discord receives, that the buttons it drew are the buttons posted, and
 * that an edit made after the install is what drift and repair read — through the autosave,
 * the routes, the provisioning engine and real discord.js together.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = [
    'ViewChannel',
    'ManageChannels',
    'ManageRoles',
    'SendMessages',
    'EmbedLinks',
    'AttachFiles',
    'ReadMessageHistory',
];
const OPERATOR = { id: '100000000000000005', username: 'e2e-operator' };
const FLOW_NAME = 'Rules door';
const PICTURE = gradientPng(120, 40, [0, 162, 255], [255, 45, 149], [255, 255, 255]);

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** The last dialog opened: Mantine portals stack in the order they open. */
function topDialog(): HTMLElement {
    const top = screen.getAllByRole('dialog').at(-1);
    if (!top) throw new Error('No dialog is open.');
    return top;
}

describe('a message a journey declares', () => {
    it('posts with its picture and buttons, reads out of date after an edit, repairs in place, and goes on uninstall', async () => {
        const discord = new TestDiscord();
        running.push(discord);
        const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
        const client = await discord.start();

        const faults: string[] = [];
        const api = createSeedApi(buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }), discord);
        const guildPath = `/api/guilds/${guild.id}`;
        const upload = await api.sendBytes<{ uploadId: string }>(`${guildPath}/uploads?name=rules-header.png`, PICTURE);
        const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: FLOW_NAME });
        const flowPath = `${guildPath}/flows/${flow.flowId}`;
        const storedResources = async () =>
            (await api.send<{ resources: ResourceDeclaration[] }>('GET', `${flowPath}/resources`)).resources;

        const dashboard = installDashboardApi(client, OPERATOR);
        const builder = renderDashboard(`/flows/${flow.flowId}`);
        const { user } = builder;

        // A channel, then a message — which lands in that channel, on one embed titled with its name.
        await user.click(await screen.findByRole('button', { name: /^Resources/ }));
        const resourcesDialog = await screen.findByRole('dialog', { name: 'Resources this flow needs' });
        await user.click(within(resourcesDialog).getByRole('button', { name: 'Channel' }));
        await user.click(within(resourcesDialog).getByRole('button', { name: 'Message' }));
        // Both rows are open; the new one's name has the focus.
        const name = within(resourcesDialog)
            .getAllByRole('textbox', { name: 'Name' })
            .find((box) => box === document.activeElement);
        if (!name) throw new Error("The new message's name isn't focused.");
        await user.clear(name);
        await user.type(name, 'Rules panel');

        // The window: the uploaded picture as the embed's image, and two buttons.
        await user.click(within(resourcesDialog).getByRole('button', { name: 'Edit message' }));
        const window = topDialog();
        await user.click(within(window).getByRole('button', { name: 'Embed 1 image' }));
        await user.click(await screen.findByRole('button', { name: 'Use rules-header.png' }));
        await user.click(within(topDialog()).getByRole('button', { name: 'Done' }));
        await user.click(within(window).getByRole('button', { name: 'Add button' }));
        await user.click(within(window).getByRole('button', { name: 'Add button' }));
        expect(within(window).getAllByText('↳ Nothing listening yet')).toHaveLength(2);

        // Escape closes the window, keeping the edit — and only the window.
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
        expect(screen.getByRole('dialog', { name: 'Resources this flow needs' })).toBeTruthy();

        await waitFor(async () =>
            expect(await storedResources()).toEqual([
                { key: 'new-channel', kind: 'textChannel', defaultName: 'new-channel' },
                {
                    key: 'rules-panel',
                    kind: 'message',
                    defaultName: 'Rules panel',
                    parentKey: 'new-channel',
                    message: { embeds: [{ title: 'New message', image: `upload:${upload.uploadId}` }] },
                    buttons: [
                        { key: 'new-button', label: 'New button', style: 'Primary' },
                        { key: 'new-button-2', label: 'New button', style: 'Primary' },
                    ],
                },
            ])
        );
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resources this flow needs' })).toBeNull());

        // Install from the builder's wizard.
        await user.click(screen.getByRole('button', { name: 'Install 2' }));
        const wizard = await screen.findByRole('dialog', { name: 'Install what this flow needs' });
        await user.click(within(wizard).getByRole('button', { name: 'Install' }));
        await user.click(within(wizard).getByRole('button', { name: 'Yes, build it' }));
        await waitFor(() => expect(dashboard.requests).toContainEqual({ method: 'POST', path: `${flowPath}/install` }));

        // Discord holds it: one message, the picture attached, the two buttons on it.
        const channelId = await waitFor(() => {
            const found = discord.clientGuild(guild).channels.cache.find((channel) => channel.name === 'new-channel');
            expect(found).toBeTruthy();
            return found?.id ?? '';
        });
        const channel = guild.channel(channelId);
        await waitFor(() => expect(channel.messages).toHaveLength(1));
        const [posted] = channel.messages;
        if (!posted) throw new Error('Nothing was posted.');
        expect(posted.embeds.map((embed) => embed.title)).toEqual(['New message']);
        expect(posted.attachments).toHaveLength(1);
        expect(posted.embeds[0]?.image?.url).toBe(`attachment://${posted.attachments[0]?.filename}`);
        const buttons = posted.components.flatMap((row) => row.components);
        expect(buttons.map((button) => ('custom_id' in button ? button.custom_id : undefined))).toEqual([
            expect.stringMatching(/^mbtn:/),
            expect.stringMatching(/^mbtn:/),
        ]);
        expect(faults).toEqual([]);
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Install what this flow needs' })).toBeNull());

        // An edit after the install stays in the builder until a repair takes it to Discord.
        await user.click(await screen.findByRole('button', { name: /^Resources/ }));
        const reopened = await screen.findByRole('dialog', { name: 'Resources this flow needs' });
        await user.click(await within(reopened).findByRole('button', { name: 'Expand Rules panel' }));
        await user.click(within(reopened).getByRole('button', { name: 'Edit message' }));
        const editWindow = topDialog();
        await user.click(within(editWindow).getByRole('button', { name: 'Embed 1 title' }));
        await user.clear(within(editWindow).getByRole('textbox', { name: 'Embed 1 title' }));
        await user.type(within(editWindow).getByRole('textbox', { name: 'Embed 1 title' }), 'House rules');
        await user.click(within(editWindow).getByRole('button', { name: 'Done' }));
        await waitFor(async () =>
            expect((await storedResources()).find((resource) => resource.key === 'rules-panel')?.message).toEqual({
                embeds: [{ title: 'House rules', image: `upload:${upload.uploadId}` }],
            })
        );
        expect(channel.message(posted.id).embeds.map((embed) => embed.title)).toEqual(['New message']);
        builder.unmount();

        // The flows list's drift check finds it out of date, and repair edits it where it stands.
        const list = renderDashboard('/flows');
        await list.user.click(within(await flowRow(FLOW_NAME)).getByRole('button', { name: `Check ${FLOW_NAME} for drift` }));
        expect(
            await screen.findByText(
                "What's posted is older than this journey's message. Repair edits it in place, so it keeps its spot in the channel."
            )
        ).toBeTruthy();
        await list.user.click(await screen.findByRole('button', { name: 'Repair 1 resource' }));
        expect(await screen.findByText('All 2 things this flow installed are still exactly as declared.')).toBeTruthy();
        expect(channel.messages.map((message) => message.id)).toEqual([posted.id]);
        expect(channel.message(posted.id).embeds.map((embed) => embed.title)).toEqual(['House rules']);
        expect(channel.message(posted.id).components.flatMap((row) => row.components)).toHaveLength(2);
        await list.user.click(screen.getByRole('button', { name: 'Done' }));

        // Uninstall deletes the message before the channel it sits in.
        await list.user.click(within(await flowRow(FLOW_NAME)).getByRole('button', { name: `Manage what ${FLOW_NAME} published` }));
        const inventory = await screen.findByRole('dialog', { name: `What ${FLOW_NAME} has in your server` });
        await list.user.click(await within(inventory).findByRole('button', { name: 'Delete 2 resources' }));
        await list.user.click(within(inventory).getByRole('button', { name: 'Yes, delete 2 resources' }));
        await waitFor(() =>
            expect(discord.requests).toContainEqual(
                expect.objectContaining({ method: 'DELETE', path: `/channels/${channelId}/messages/${posted.id}` })
            )
        );
        await waitFor(() =>
            expect(discord.requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: `/channels/${channelId}` }))
        );
        expect(faults).toEqual([]);
    });
});
