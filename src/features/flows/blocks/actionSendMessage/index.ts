import { z } from 'zod';
import { messageConfigSchema, trimMessageText } from '../../../../shared/discordMessage';
import { messageButtonsConfigSchema } from '../../../provisioning/logic/messageButtonSchema';
import { recordPostedMessage } from '../../logic/recordPostedMessage';
import type { BlockManifest } from '../manifest';
import {
    CHANNEL_CHOICE_CARD_PART,
    CHANNEL_CHOICE_FIELD,
    CHANNEL_PICKER_FIELD,
    channelChoiceShape,
    channelFor,
    checkChannelChoice,
} from '../channelChoice';
import { messageWithButtons, renderedMessageIssue } from '../messageWithButtons';

export const ACTION_SEND_MESSAGE = 'action.sendMessage';

/** The message field's label: what the form shows, and what every failure names a part by. */
const MESSAGE_LABEL = 'Message';

/** What a private answer carrying buttons is refused with, under the buttons. */
const EPHEMERAL_BUTTONS_MESSAGE =
    "Buttons can't go on a message only the clicker sees — untick that, or drop the buttons.";

/**
 * Where to post, the whole message — plain text, up to ten embeds under it, or both — and the
 * buttons under that.
 *
 * Where is the shared channel choice (`blocks/channelChoice.ts`): a picked channel, the
 * default every node saved before the choice means, or the channel the run happened in.
 *
 * The message is one key holding one object (`src/shared/discordMessage`), edited by the
 * `message` control. This block took over Post Embed: `2026-10-31-Send_Message_Takes_Post_Embed`
 * turned every `action.postEmbed` node into this type, data untouched, and every message that
 * was a string into `{ content, embeds: [] }`; this schema reads only the object.
 *
 * `buttons` is the message field's `buttonsKey`: drawn and edited in the message window, and
 * optional — absent or empty posts none.
 *
 * `ephemeral` answers the button press instead of posting: only the person who pressed sees
 * it. It is shown only under "the channel this happened in" (`visibleWhen`, so absent — and
 * so off — otherwise): a reply to a press lands where the press was, never in a channel the
 * author picked, and a box under "a channel I pick" would promise a choice it cannot keep.
 * A private answer with buttons is refused: nobody asked for one, and a press on it was never
 * routed or tried.
 */
export const sendMessageConfigSchema = z
    .object({
        ...channelChoiceShape,
        ephemeral: z.boolean().default(false),
        message: messageConfigSchema,
        buttons: messageButtonsConfigSchema.optional(),
    })
    .superRefine((config, context) => {
        checkChannelChoice(config, context);
        if (config.ephemeral && config.buttons && config.buttons.length > 0) {
            context.addIssue({ code: 'custom', path: ['buttons'], message: EPHEMERAL_BUTTONS_MESSAGE });
        }
    });

export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

export const block: BlockManifest<SendMessageConfig> = {
    type: ACTION_SEND_MESSAGE,
    kind: 'action',
    label: 'Send Message',
    description:
        'Open your mouth — words, embeds, or both, buttons if you want them pressed — right where it happened, or in a channel of your choosing.',
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
            label: MESSAGE_LABEL,
            description: 'Some plain text, up to ten embeds under it, or both — and buttons, if you like. Click a part to dress it up.',
            control: 'message',
            swatches: ['#00A2FF', '#FF2D95', '#7A5CFF', '#FF6B35'],
            buttonsKey: 'buttons',
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
    capabilities: ['sendMessages', 'embedLinks', 'attachFiles'],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        /*
         * Cheapest first. The message as rendered is judged before anything is read — a
         * message that can never post costs no lookup at all. Then where it goes: the press a
         * private answer follows up, or the channel, which is nearly always the guild's cache,
         * so a channel deleted since the save fails before any upload is read. Then the
         * uploads: their sizes, judged, and their bytes last.
         */
        const message = trimMessageText(config.message);
        const issue = renderedMessageIssue(message, MESSAGE_LABEL);
        if (issue) {
            return { kind: 'fail', error: issue };
        }

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
            // No buttons: save refuses them beside the box, so a private answer never carries any.
            const ready = await messageWithButtons(context.guild, message, [], MESSAGE_LABEL);
            if (ready.kind === 'fail') {
                return { kind: 'fail', error: ready.error };
            }
            // Everything but `flags`, whose channel-post type a reply's does not take (none is set).
            const { flags: _channelFlags, ...reply } = ready.options;
            await interaction.followUp({ ...reply, ephemeral: true });
            return { kind: 'continue' };
        }

        // The picked channel or the run's own, this guild's only, and thrown for one that is
        // not sendable here — see `channelFor` and `requireChannelInGuild` for why never the
        // client's.
        const channel = await channelFor(context, config);

        // Mentions are pinned to users only (`messageWithButtons`): the copy is a template, so a
        // member called "@everyone" reaching it through `{{subject.username}}` pings nobody, and
        // `{{subject.mention}}` still pings the one member it names.
        const buttons = config.buttons ?? [];
        const ready = await messageWithButtons(context.guild, message, buttons, MESSAGE_LABEL);
        if (ready.kind === 'fail') {
            return { kind: 'fail', error: ready.error };
        }

        const posted = await channel.send(ready.options);
        await recordPostedMessage({ posted, buttons, context });
        return { kind: 'continue' };
    },
};
