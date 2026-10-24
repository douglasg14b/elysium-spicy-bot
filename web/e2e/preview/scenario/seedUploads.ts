import { ACTION_POST_EMBED } from '../../../../src/features/flows/blocks/actionPostEmbed';
import { TRIGGER_MEMBER_JOIN } from '../../../../src/features/flows/blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../../src/features/flows/data/flowGraph';
import type { PreviewPage } from '../previewPages';
import { gradientPng } from './gradientPng';
import type { SeedContext } from './seedScenario';

interface CreatedFlow {
    readonly flowId: string;
    readonly updatedAt: string;
}

interface KeptUpload {
    readonly uploadId: string;
}

/**
 * The Uploads page, beside the three pictures the message editor's seed put in use: two that
 * nothing uses, and one shown only in an unsaved draft, so a card carries the DRAFT mark.
 * Runs after `seedMessageEditor`, whose Welcome message holds `logo.png`.
 */
export async function seedUploads({ guild, api }: SeedContext): Promise<PreviewPage[]> {
    const guildPath = `/api/guilds/${guild.guild.id}`;
    const upload = (name: string, bytes: Uint8Array) =>
        api.sendBytes<KeptUpload>(`${guildPath}/uploads?name=${encodeURIComponent(name)}`, bytes);

    const divider = await upload('divider.png', gradientPng(600, 40, [49, 51, 64], [42, 43, 52], [151, 117, 250]));
    await upload('event-poster-oct.png', gradientPng(900, 1200, [255, 146, 43], [255, 45, 149], [255, 212, 59]));
    await upload('old-rules-header.png', gradientPng(1200, 400, [0, 162, 255], [32, 201, 151], [255, 255, 255]));

    // Saved with nothing in it; the picture is only in the operator's draft.
    const flow = await api.send<CreatedFlow>('POST', `${guildPath}/flows`, { name: 'Birthday shout' });
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: 'shout',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 180 },
                data: {
                    channelId: guild.channels.introductions.id,
                    message: {
                        embeds: [
                            {
                                title: 'Happy birthday, {{subject.displayName}}',
                                image: `upload:${divider.uploadId}`,
                                footer: { text: 'Another year, still trouble.', iconUrl: `upload:${divider.uploadId}` },
                            },
                        ],
                    },
                },
            },
        ],
        edges: [{ id: 'joined-shout', source: 'joined', target: 'shout' }],
    };
    await api.send('PUT', `${guildPath}/flows/${flow.flowId}/drafts/mine`, {
        name: 'Birthday shout',
        graph,
        baseUpdatedAt: flow.updatedAt,
    });

    return [
        { name: 'uploads', path: '/uploads', note: 'the meter, the drop zone, and every card with its uses (one DRAFT)' },
        {
            name: 'uploads-delete-unused',
            path: '/uploads',
            note: 'the delete dialog for a picture nothing uses — click Delete on old-rules-header.png',
            steps: [{ clickButton: 'Delete old-rules-header.png' }],
        },
        {
            name: 'uploads-delete-used',
            path: '/uploads',
            note: 'the refusal for a picture in use, listing each place — click Delete on logo.png',
            steps: [{ clickButton: 'Delete logo.png' }],
        },
    ];
}
