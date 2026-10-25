import type { ResourceDeclaration } from '@brattybot/web-sdk';
import type { PreviewPage, PreviewStep } from '../previewPages';
import { gradientPng } from './gradientPng';
import type { SeedContext } from './seedScenario';

interface CreatedFlow {
    readonly flowId: string;
}

interface KeptUpload {
    readonly uploadId: string;
}

const FLOW_NAME = 'Front door';

/**
 * A flow's journey declaring a message: a channel, and a rules panel in it with a banner
 * from an upload and three buttons. Installed through the route, so Discord holds it, then
 * its title changed in the declaration — so the resources dialog shows the newer message and
 * the drift check reads what is posted as out of date.
 */
export async function seedMessageResource({ guild, api }: SeedContext): Promise<PreviewPage[]> {
    const guildPath = `/api/guilds/${guild.guild.id}`;
    const banner = await api.sendBytes<KeptUpload>(
        `${guildPath}/uploads?name=${encodeURIComponent('house-rules-banner.png')}`,
        gradientPng(800, 240, [255, 45, 149], [122, 92, 255], [0, 162, 255])
    );

    const flow = await api.send<CreatedFlow>('POST', `${guildPath}/flows`, { name: FLOW_NAME });
    const flowPath = `${guildPath}/flows/${flow.flowId}`;
    const declare = (title: string) =>
        api.send('PUT', `${flowPath}/resources`, { resources: rulesPanel(title, banner.uploadId) });

    await declare('House rules');
    await api.send('POST', `${flowPath}/install`, {});
    await declare('House rules — read them, then pick');

    const builder = `/flows/${flow.flowId}`;
    const openRow: readonly PreviewStep[] = [{ clickButton: 'Resources 2' }, { clickButton: 'Expand Rules panel' }];
    return [
        {
            name: 'message-resource-row',
            path: builder,
            note: 'the resources dialog with the message row open: Posted in (locked), the preview card — click Resources, then expand Rules panel',
            steps: openRow,
        },
        {
            name: 'message-resource-window',
            path: builder,
            note: 'the message window with its three buttons, no {x} and no Token tab — then Edit message',
            steps: [...openRow, { clickButton: 'Edit message' }],
        },
        {
            name: 'message-resource-drift',
            path: '/flows',
            note: `the drift report for ${FLOW_NAME}: its message out of date — click the radar on the row`,
            steps: [{ clickButton: `Check ${FLOW_NAME} for drift` }],
        },
        {
            name: 'message-resource-uploads',
            path: '/uploads',
            note: 'house-rules-banner.png used by the journey: "Front door · message Rules panel · embed 1 image"',
        },
    ];
}

function rulesPanel(title: string, uploadId: string): ResourceDeclaration[] {
    return [
        { key: 'house-rules', kind: 'textChannel', defaultName: 'house-rules' },
        {
            key: 'rules-panel',
            kind: 'message',
            defaultName: 'Rules panel',
            parentKey: 'house-rules',
            message: {
                content: 'Read it all. Yes, all of it.',
                embeds: [
                    {
                        color: '#FF2D95',
                        title,
                        description:
                            'Consent first, every time. Safewords are sacred. No DMs without asking.\n\n' +
                            'Break the rules and we will make an example of you — and not the fun kind.',
                        image: `upload:${uploadId}`,
                        footer: { text: 'The Management' },
                    },
                ],
            },
            buttons: [
                { key: 'i-agree', label: 'I agree, let me in', style: 'Success' },
                { key: 'safewords', label: 'Remind me of the safewords', style: 'Secondary' },
                { key: 'nope', label: 'Not for me', style: 'Danger' },
            ],
        },
    ];
}
