import { ACTION_POST_EMBED } from '../../../../src/features/flows/blocks/actionPostEmbed';
import { TRIGGER_MEMBER_JOIN } from '../../../../src/features/flows/blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../../src/features/flows/data/flowGraph';
import type { PreviewPage, PreviewStep } from '../previewPages';
import { gradientPng } from './gradientPng';
import type { SeedContext } from './seedScenario';

interface CreatedFlow {
    readonly flowId: string;
}

interface KeptUpload {
    readonly uploadId: string;
}

/**
 * A Post Embed with a full message to open the message window on: plain text with a ping, a
 * first embed with every part filled — header icon, thumbnail, three inline fields, a big
 * image, a footer icon, the timestamp — from three uploaded pictures, and a second embed with
 * only a title and a token thumbnail, so the rest of it shows as placeholders.
 */
export async function seedMessageEditor({ guild, api }: SeedContext): Promise<PreviewPage[]> {
    const guildPath = `/api/guilds/${guild.guild.id}`;
    const upload = (name: string, bytes: Uint8Array) =>
        api.sendBytes<KeptUpload>(`${guildPath}/uploads?name=${encodeURIComponent(name)}`, bytes);

    const icon = await upload('management.png', gradientPng(96, 96, [255, 45, 149], [0, 162, 255], [122, 92, 255]));
    const logo = await upload('logo.png', gradientPng(160, 160, [122, 92, 255], [255, 45, 149], [255, 255, 255]));
    const banner = await upload('banner.png', gradientPng(640, 260, [30, 31, 36], [0, 120, 200], [255, 45, 149]));

    const flow = await api.send<CreatedFlow>('POST', `${guildPath}/flows`, { name: 'Welcome message' });
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: 'welcome',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 180 },
                data: {
                    channelId: guild.channels.introductions.id,
                    message: {
                        content: 'Hey {{subject.mention}}, glad you found us.',
                        embeds: [
                            {
                                color: '#00A2FF',
                                author: { name: 'The Management', iconUrl: `upload:${icon.uploadId}` },
                                title: 'Welcome to Pacific Elysium',
                                description:
                                    'Read the house rules, then hit the button below to get verified. Staff will be with you shortly.\n\n' +
                                    "Be nice. Or don't — but be interesting.",
                                thumbnail: `upload:${logo.uploadId}`,
                                fields: [
                                    { name: 'Age', value: '18+, no exceptions', inline: true },
                                    { name: 'Safewords', value: 'Red / Yellow', inline: true },
                                    { name: 'Wait time', value: 'Under an hour', inline: true },
                                ],
                                image: `upload:${banner.uploadId}`,
                                footer: { text: 'Behave yourselves.', iconUrl: `upload:${icon.uploadId}` },
                                timestamp: true,
                            },
                            { color: '#FF2D95', title: 'House rules', thumbnail: '{{subject.avatarUrl}}' },
                        ],
                    },
                },
            },
        ],
        edges: [{ id: 'joined-welcome', source: 'joined', target: 'welcome' }],
    };
    await api.send('PUT', `${guildPath}/flows/${flow.flowId}`, { graph });

    const path = `/flows/${flow.flowId}`;
    const open: readonly PreviewStep[] = [{ clickText: 'Welcome to Pacific' }, { clickButton: 'Edit message' }];
    return [
        { name: 'message-editor', path, note: 'the message window, two embeds — click the card, then Edit message', steps: open },
        {
            name: 'message-editor-title',
            path,
            note: 'the first title being typed into, with its count and {x}',
            steps: [...open, { clickButton: 'Embed 1 title' }],
        },
        {
            name: 'message-editor-picture',
            path,
            note: "the second embed's image box open: Upload, Link, Token, and this server's pictures",
            steps: [...open, { clickButton: 'Embed 2 image' }],
        },
        {
            name: 'message-editor-preview',
            path,
            note: 'Preview: tokens filled in, a stand-in face for the avatar token',
            steps: [...open, { clickText: 'Preview' }],
        },
    ];
}
