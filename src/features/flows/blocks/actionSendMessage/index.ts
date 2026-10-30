import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import {
    CHANNEL_CHOICE_CARD_PART,
    CHANNEL_CHOICE_FIELD,
    CHANNEL_PICKER_FIELD,
    channelChoiceShape,
    channelFor,
    checkChannelChoice,
} from '../channelChoice';

export const ACTION_SEND_MESSAGE = 'action.sendMessage';

/**
 * Where to post — the shared channel choice (`blocks/channelChoice.ts`): a picked channel, the
 * default every node saved before the choice means, or the channel the run happened in — and
 * what to say.
 *
 * `ephemeral` answers the button press instead of posting: only the person who pressed sees
 * it. It is shown only under "the channel this happened in" (`visibleWhen`, so absent — and
 * so off — otherwise): a reply to a press lands where the press was, never in a channel the
 * author picked, and a box under "a channel I pick" would promise a choice it cannot keep.
 */
export const sendMessageConfigSchema = z
    .object({
        ...channelChoiceShape,
        ephemeral: z.boolean().default(false),
        message: z.string().min(1).max(2000),
    })
    .superRefine((config, context) => checkChannelChoice(config, context));

export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

export const block: BlockManifest<SendMessageConfig> = {
    type: ACTION_SEND_MESSAGE,
    kind: 'action',
    label: 'Send Message',
    description: 'Say something out loud — right where it happened, or in a channel of your choosing.',
    group: 'actions',
    icon: '💬',
    configSchema: sendMessageConfigSchema,
    configFields: [
        CHANNEL_CHOICE_FIELD,
        CHANNEL_PICKER_FIELD,
        {
            key: 'ephemeral',
            label: 'Only the person who clicked sees it',
            description:
                'Answers their button press privately instead of posting in the channel. Only works while ' +
                'the run is still answering that press — not after a Delay or a Wait for Event.',
            control: 'toggle',
            defaultValue: false,
            requiresWhenOn: ['interaction'],
            visibleWhen: { field: CHANNEL_CHOICE_FIELD.key, equals: ['here'] },
        },
        {
            key: 'message',
            label: 'Message',
            control: 'longText',
            placeholder: 'Say something spicy…',
            maxLength: 2000,
            rendersTokens: true,
        },
    ],
    // "#general · "Say something…"", or "The channel this happened in · …" — the hidden
    // picker's part renders nothing, so only one of the first two ever shows.
    cardSummary: [
        CHANNEL_CHOICE_CARD_PART,
        { key: 'channelId', emptyText: 'no channel picked' },
        // A ticked box names itself; an unticked one is unset, so renders nothing.
        { key: 'ephemeral', prefix: ' · ', hideWhenEmpty: true },
        { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: ['sendMessages'],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        if (config.ephemeral) {
            // The press was acknowledged with `deferUpdate`, so this is a follow-up: a new message
            // only the presser sees. The executor refused the node before `run` if the run has no
            // press (`requiresWhenOn`), so a miss here is that check regressing, not a state of the
            // world — unlike a channel, which can vanish while a run is parked.
            const { interaction } = context;
            if (!interaction) {
                throw new Error(
                    'This block is set to answer the button press privately, and this run has none. The executor ' +
                        'should have refused the node — `requiresWhenOn` has regressed.'
                );
            }
            await interaction.followUp({
                content: config.message,
                ephemeral: true,
                allowedMentions: { parse: ['users'] },
            });
            return { kind: 'continue' };
        }

        // The picked channel or the run's own, this guild's only — see `channelFor` and
        // `requireChannelInGuild` for why never the client's. Throws for one that is not
        // sendable here.
        const channel = await channelFor(context, config);
        // Mentions are pinned to users only. Copy is a template now, so a member's
        // own display name reaches this string — and a member called "@everyone"
        // would otherwise make any flow saying `{{subject.username}}` ping the
        // whole guild with the bot's permissions. `users` keeps `{{subject.mention}}`
        // working, which is the point of it.
        await channel.send({ content: config.message, allowedMentions: { parse: ['users'] } });
        return { kind: 'continue' };
    },
};
