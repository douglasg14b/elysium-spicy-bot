import type { GuildTextBasedChannel } from 'discord.js';
import { z } from 'zod';
import { requireChannelInGuild } from './channelInGuild';
import type { BlockCardSummaryPart, BlockConfigField } from './manifest';
import type { FlowRunSeed } from './types';

/**
 * Where a block posts: a channel the author **picked** (`channel`), or the channel the run
 * **happened in** (`here`) — where the button was pressed, the message sent, the reaction
 * added.
 *
 * The words of Message Sent's own `where`, which already calls a picked channel `channel`.
 * `channel` first: it is the default, and every graph saved before the choice existed means
 * it — an unset choice reads as its declared default everywhere (`effectiveFieldValue`), so
 * no migration.
 */
export const CHANNEL_CHOICES = ['channel', 'here'] as const;

export type ChannelChoice = (typeof CHANNEL_CHOICES)[number];

/**
 * The choice's piece of a block's config schema, spread into its `z.object`: the choice
 * under the key {@link CHANNEL_CHOICE_FIELD} edits, and the picker it shows.
 *
 * The choice is defaulted, so a node saved before it existed parses as `channel`. The picker
 * is shown only for `channel` (`visibleWhen`), so it is optional — absent is what it is while
 * hidden — and "required when shown" lives in {@link checkChannelChoice}. It stays
 * `.min(1).optional()` rather than a bare optional string so an empty pick is refused as *too
 * short*: the one complaint save forgives for a picker naming a channel the flow declares but
 * has not installed yet (`trigger.messageSent`, the same reasoning).
 *
 * **No sentinel in the snowflake.** `channelId` holds a channel id or one `{{var.<name>}}`,
 * never a word meaning "here": the choice is its own key.
 */
export const channelChoiceShape = {
    where: z.enum(CHANNEL_CHOICES).default('channel'),
    channelId: z.string().min(1).optional(),
};

/** What {@link checkChannelChoice} and {@link channelFor} read off a parsed config — derived, so it cannot drift from the shape. */
export type ChannelChoiceConfig = Readonly<z.output<z.ZodObject<typeof channelChoiceShape>>>;

/**
 * Refuse "a channel I pick" with nothing picked, under the picker — for the block's own
 * `superRefine`.
 *
 * Hidden fields never reach this — save-time validation and the executor leave them out
 * first — so a channel left over from before the author switched to "here" is never judged.
 */
export function checkChannelChoice(config: ChannelChoiceConfig, context: z.RefinementCtx): void {
    if (config.where === 'channel' && config.channelId === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['channelId'],
            message: 'Which channel? Pick one — or post in the channel this happened in.',
        });
    }
}

/**
 * The "Where" field, shared by every block that posts into one channel.
 *
 * The block's own `requires` says nothing of a channel; the "here" option says it needs one,
 * so picking it is refused at save below a trigger that does not declare `channel` (Schedule,
 * Member Joins, Member Leaves, Level Reached, Ticket Event — whose runs do carry the ticket's
 * channel when it resolves, but whose trigger does not promise one) and greyed in the builder
 * there. A park keeps the channel — resume fetches it again — so a wait above does not
 * grey it. One declaration, so the blocks cannot come to word or require it differently.
 */
export const CHANNEL_CHOICE_FIELD = {
    key: 'where',
    label: 'Where',
    description:
        'A channel you pick, or wherever this happened — the channel the button was pressed, the message sent or ' +
        'the reaction left in. Not after a Schedule or a member joining: those happen nowhere in particular.',
    control: 'select',
    defaultValue: 'channel',
    options: [
        { value: 'channel', label: 'A channel I pick' },
        { value: 'here', label: 'The channel this happened in', requires: ['channel'] },
    ],
} as const satisfies BlockConfigField;

/**
 * The picker, shown only while the choice is "a channel I pick". Shared so both blocks hide
 * it on the same value.
 */
export const CHANNEL_PICKER_FIELD = {
    key: 'channelId',
    label: 'Channel',
    description: 'Where the message gets posted.',
    control: 'channelPicker',
    visibleWhen: { field: CHANNEL_CHOICE_FIELD.key, equals: ['channel'] },
} as const satisfies BlockConfigField;

/**
 * The card part naming the choice, shown only while it is not the default — the card names
 * the picked channel otherwise, and that part renders nothing while the picker is hidden, so
 * exactly one of the two speaks. Placed before the picker's part, so it leads the line.
 */
export const CHANNEL_CHOICE_CARD_PART = {
    key: CHANNEL_CHOICE_FIELD.key,
    visibleWhen: { field: CHANNEL_CHOICE_FIELD.key, equals: ['here'] },
} as const satisfies BlockCardSummaryPart;

/**
 * The channel a block's choice sends to, resolved from the run's own guild — or a thrown error.
 *
 * Both arms go through {@link requireChannelInGuild}, so the run's channel is held to the same
 * rule as a picked one: a text channel of **this** guild the bot can send to, refused by name
 * otherwise. Thrown, as that is, the convention of the blocks that post.
 *
 * **Unlike `memberFor`, a missing channel is not a regression.** The executor leaves `channel`
 * to the block (`RUN_CHECKS` in `engine/nodeRequirements.ts`): save refuses a path that could
 * never have one, but a channel deleted or walled off while the run was parked resumes as
 * nowhere on purpose, and a button pressed in a channel discord.js could not resolve starts a
 * run with none. Those are real states of the world, and they fail by name.
 */
export async function channelFor(context: FlowRunSeed, config: ChannelChoiceConfig): Promise<GuildTextBasedChannel> {
    switch (config.where) {
        case 'channel': {
            if (config.channelId === undefined) {
                throw new Error(
                    'This block is set to post in a channel it picked, and none is picked. Its schema should have ' +
                        'refused the node — `checkChannelChoice` has regressed.'
                );
            }
            return requireChannelInGuild(context.guild, config.channelId);
        }
        case 'here': {
            const { channel } = context;
            if (!channel) {
                throw new Error(
                    "This block is set to post in the channel this happened in, and this run isn't in a channel the " +
                        "bot can reach — it's gone, walled off, or was never there."
                );
            }
            return requireChannelInGuild(context.guild, channel.id);
        }
        default: {
            const illegal: never = config.where;
            throw new Error(`Unknown channel choice ${JSON.stringify(illegal)}.`);
        }
    }
}
