import { randomBytes } from 'node:crypto';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACTION_POST_EMBED } from '../../src/features/flows/blocks/actionPostEmbed';
import { TRIGGER_SCHEDULE } from '../../src/features/flows/blocks/triggerSchedule';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { executeFlow } from '../../src/features/flows/engine/executor';
import { TestDiscord, type ServerChannel, type ServerGuild } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * A picture uploaded in the message window reaches Discord with the message: the builder, the
 * upload route and the database, the flow save, and a run of the saved flow against
 * TestDiscord — so the file is proven by the multipart request Discord would receive, not by
 * what any one layer handed the next.
 *
 * The Post Embed opens in the shape the migration leaves an old one in: one embed, under
 * `message`. The run is started by hand on the saved graph, since nothing here runs the
 * scheduler.
 */

const OPERATOR = { id: '100000000000000004', username: 'e2e-operator' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(512)]);

interface AuthoredFlow {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly channel: ServerChannel;
    readonly api: SeedApi;
    readonly flowId: string;
    readonly flowPath: string;
}

interface StoredFlow {
    readonly graph: FlowGraph;
    readonly issues: readonly unknown[];
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A switched-off flow: every day at nine, Post Embed one embed into #notices. */
async function guildWithPostEmbed(): Promise<AuthoredFlow> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild({ bot: { permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'] } });
    const channel = guild.createTextChannel({ name: 'notices' });
    const client = await discord.start();

    const api = createSeedApi(buildDashboardApp({ client, operator: OPERATOR, onFault: () => undefined }), discord);
    const guildPath = `/api/guilds/${guild.id}`;
    const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: 'Dress code' });
    const flowPath = `${guildPath}/flows/${flow.flowId}`;

    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'nine', type: TRIGGER_SCHEDULE, position: { x: 0, y: 0 }, data: { repeat: 'daily', time: '09:00' } },
            {
                id: 'post',
                type: ACTION_POST_EMBED,
                position: { x: 300, y: 0 },
                data: { channelId: channel.id, message: { embeds: [{ title: 'Dress code', description: 'Collars on.' }] } },
            },
        ],
        edges: [{ id: 'nine-post', source: 'nine', target: 'post' }],
    };
    const saved = await api.send<StoredFlow>('PUT', flowPath, { graph });
    expect(saved.issues).toEqual([]);

    return { discord, client, guild, channel, api, flowId: flow.flowId, flowPath };
}

describe('a picture uploaded in the message window', () => {
    it('is saved on the node and attached to the message the flow posts', async () => {
        const authored = await guildWithPostEmbed();
        installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${authored.flowId}`);

        // Select the Post Embed card by its summary line — a bare click, as `flowNextRun` explains.
        fireEvent.click(await screen.findByText(/"Dress code"/));
        await user.click(await screen.findByRole('button', { name: 'Edit message' }));
        const window = screen.getByRole('dialog');

        // A footer icon needs footer text beside it, or Discord drops it.
        await user.click(within(window).getByRole('button', { name: 'Embed 1 footer' }));
        await user.type(within(window).getByRole('textbox', { name: 'Embed 1 footer' }), 'Behave.');
        await user.click(within(window).getByRole('button', { name: 'Embed 1 footer icon' }));
        const chooser = screen.getByLabelText('Upload a picture');
        const pictureBox = chooser.closest<HTMLElement>('[role="dialog"]');
        if (!pictureBox) throw new Error("The upload input isn't inside the picture's box.");
        await user.upload(chooser, new File([PNG], 'collar.png', { type: 'image/png' }));

        // Shown from the signed-in route as soon as the server has kept it.
        const shown = await waitFor(() => {
            const image = within(window)
                .getByRole('button', { name: 'Embed 1 footer icon' })
                .querySelector<HTMLImageElement>('img');
            expect(image?.getAttribute('src')).toMatch(new RegExp(`^/api/guilds/${authored.guild.id}/uploads/[0-9a-f-]{36}$`));
            return image;
        });
        const uploadId = shown?.getAttribute('src')?.split('/').at(-1) ?? '';
        await user.click(within(pictureBox).getByRole('button', { name: 'Done' }));
        await user.click(within(window).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('All changes saved')).toBeTruthy();

        const stored = await authored.api.send<StoredFlow>('GET', authored.flowPath);
        expect(stored.issues).toEqual([]);
        expect(stored.graph.nodes.find((node) => node.id === 'post')?.data.message).toEqual({
            embeds: [
                {
                    title: 'Dress code',
                    description: 'Collars on.',
                    footer: { text: 'Behave.', iconUrl: `upload:${uploadId}` },
                },
            ],
        });

        // The saved flow, run: the picture travels as a file, and the footer points at it.
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const from = authored.discord.writesTo(authored.channel).length;
        const result = await executeFlow(authored.flowId, stored.graph, 'nine', {
            client: authored.client,
            guild: authored.discord.clientGuild(authored.guild),
            variables: {},
        });

        expect(result).toMatchObject({ status: 'success' });
        const [write] = authored.discord.writesTo(authored.channel).slice(from);
        expect(write?.files).toEqual([{ index: 0, name: `${uploadId}.png`, contentType: 'image/png', bytes: PNG }]);
        expect(write?.body).toMatchObject({
            embeds: [
                {
                    title: 'Dress code',
                    description: 'Collars on.',
                    footer: { text: 'Behave.', icon_url: `attachment://${uploadId}.png` },
                },
            ],
        });
    });
});
