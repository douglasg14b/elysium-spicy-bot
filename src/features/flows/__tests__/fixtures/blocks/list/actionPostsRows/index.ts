import { z } from 'zod';
import { requireChannelInGuild } from '../../../../../blocks/channelInGuild';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A block holding copy inside the rows of an `objectList` — so a test can prove the copy
 * walk's list arm (`copyLocationsOf`), at save and at run, now that no shipped block declares
 * one: Post Embed's fields moved into its `message`.
 *
 * Its `run` posts every row as `heading: text` lines, so what was rendered is what reaches
 * the channel.
 */
export const FIXTURE_ACTION_POSTS_ROWS = 'fixture.actionPostsRows';

const rowSchema = z.object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().default(false),
});

export const actionPostsRowsConfigSchema = z.object({
    channelId: z.string().min(1),
    fields: z.array(rowSchema).max(25).default([]),
});

export type ActionPostsRowsConfig = z.infer<typeof actionPostsRowsConfigSchema>;

export const block: BlockManifest<ActionPostsRowsConfig> = {
    type: FIXTURE_ACTION_POSTS_ROWS,
    kind: 'action',
    label: 'Posts Rows',
    description: 'Posts the rows of a list it holds. Test fixture, not for a palette.',
    group: 'actions',
    icon: '📋',
    configSchema: actionPostsRowsConfigSchema,
    configFields: [
        { key: 'channelId', label: 'Channel', control: 'channelPicker' },
        {
            key: 'fields',
            label: 'Fields',
            control: 'objectList',
            columns: [
                { key: 'name', label: 'Heading', control: 'text', maxLength: 256, rendersTokens: true },
                { key: 'value', label: 'Text', control: 'longText', maxLength: 1024, rendersTokens: true },
                { key: 'inline', label: 'Side by side', control: 'toggle' },
            ],
            maxEntries: 25,
            addLabel: 'Add a field',
            defaultValue: [],
        },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: ['sendMessages'],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        const channel = await requireChannelInGuild(context.guild, config.channelId);
        await channel.send({
            content: config.fields.map((field) => `${field.name}: ${field.value}`).join('\n'),
            allowedMentions: { parse: ['users'] },
        });
        return { kind: 'continue' };
    },
};
