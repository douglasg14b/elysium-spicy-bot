import { ActionRowBuilder, ButtonBuilder, type Guild } from 'discord.js';
import {
    BUTTON_STYLE_MAP,
    BUTTON_STYLES,
    DISCORD_BUTTONS_PER_ROW,
    DISCORD_CUSTOM_ID_MAX_LENGTH,
    DISCORD_MAX_BUTTONS_PER_MESSAGE,
} from '../../../shared/discordButtons';

/**
 * The buttons under a message resource: what they look like, the id each is pressed by, and
 * the rows Discord lays them out in.
 *
 * Provisioning owns the id's prefix, because provisioning renders the buttons and may not
 * import flows. Flows registers the one handler for the prefix (`initFlows`), and step 3
 * routes a press from there to the flow listening to that button.
 */

/**
 * The styles a message's button may take: the four Button Click has, and none that cannot
 * answer a press. No Link button: nothing could listen to one, and each needs a URL.
 */
export const MESSAGE_BUTTON_STYLES = BUTTON_STYLES;
export type MessageButtonStyle = (typeof MESSAGE_BUTTON_STYLES)[number];

/** The most buttons one message carries: Discord's five rows of five. */
export const MESSAGE_MAX_BUTTONS = DISCORD_MAX_BUTTONS_PER_MESSAGE;

/**
 * The emoji beside a button's label, as Discord's own partial emoji: a standard one is its
 * glyph alone (`{ name: '🌶️' }`), one of the server's own carries its id too (`{ id, name:
 * 'blobheart', animated: false }`).
 */
export interface MessageButtonEmoji {
    /** A standard emoji's glyph, or a server emoji's name (`[A-Za-z0-9_]`, 2–32). */
    readonly name: string;
    /** A server emoji's id. Absent for a standard one. */
    readonly id?: string;
    readonly animated?: boolean;
}

/**
 * One button under a message.
 *
 * The **key** is its identity, as a resource's key is: unique within its message, it is what
 * a trigger will name and what the button's id carries, so renaming the label changes
 * nothing that listens to it.
 *
 * It has a label, an emoji, or both — never neither (`messageResourceProblems`). Both are
 * left out rather than `null` when absent, so a button without an emoji fingerprints as it
 * did before emoji existed (`messageDigest`).
 */
export interface MessageButton {
    /** Lowercase letters, digits and single hyphens, at most 64 characters — the resource key rule. */
    readonly key: string;
    /** 1–80 characters, Discord's limit, when present. */
    readonly label?: string;
    readonly style: MessageButtonStyle;
    readonly emoji?: MessageButtonEmoji;
}

/** How an emoji reads in a sentence: a standard one as its glyph, a server one as `:name:`. */
function emojiText(emoji: MessageButtonEmoji): string {
    return emoji.id ? `:${emoji.name}:` : emoji.name;
}

/**
 * What a sentence calls a button: its label, else its emoji ({@link emojiText}), else its key —
 * so an emoji-only button never reads as `""` in a claim, a refusal, drift or the install note.
 */
export function buttonDisplayName(button: Pick<MessageButton, 'key' | 'label' | 'emoji'>): string {
    if (button.label) return button.label;
    if (button.emoji) return emojiText(button.emoji);
    return button.key;
}

/**
 * Unicode's recommended emoji, one and whole: flags, keycaps, skin tones and ZWJ families
 * included; a lone regional indicator, a letter in a keycap, a skin tone on a base that takes
 * none, and an unassigned code point not. Built with `new RegExp` because the `v` flag is
 * newer than the web build's target. Reads the engine's Unicode tables, so Node and a browser
 * can disagree on an emoji newer than one of them.
 */
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

/**
 * Whether `name` is one standard emoji Discord will take: {@link RGI_EMOJI}, or one written
 * without its emoji presentation selector (`🌶` for `🌶️`), which is how a hand-typed one
 * usually arrives and which Discord shows as the emoji all the same. A lone `©` passes the
 * second way too, as Discord's `©️`.
 *
 * Mirrored, line for line, in `web/src/flows/messageResourceProblems.ts`.
 */
export function isOneEmoji(name: string): boolean {
    return RGI_EMOJI.test(name) || RGI_EMOJI.test(`${name}\u{FE0F}`);
}

/**
 * The longest emoji name a button takes: a server emoji's limit (the `32` in
 * {@link SERVER_EMOJI_NAME_PATTERN}), and room enough for the longest standard glyphs (a ZWJ
 * family with skin tones is under 20 UTF-16 units).
 */
export const MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH = 32;

/** A server emoji's name, as Discord allows one: at most {@link MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH}. */
export const SERVER_EMOJI_NAME_PATTERN = /^[A-Za-z0-9_]{2,32}$/;

/**
 * The ids of this server's emoji a button may show: every one in the cache but those Discord
 * marks unavailable (a server that lost the boosts paying for them). Kept up to date by the
 * `GuildExpressions` intent. The dashboard's emoji list (`getGuildEmojis`) is drawn from the
 * same set, so the picker and the post agree on what is gone.
 */
export function serverEmojiIds(guild: Guild): ReadonlySet<string> {
    return new Set(guild.emojis.cache.filter((emoji) => emoji.available !== false).keys());
}

/**
 * The prefix of every message button's custom_id: `mbtn:<buttonKey>`.
 *
 * Disjoint from flows' `flow:` and `flowc:` under the registry's longest-prefix match: no id
 * starting `mbtn:` starts with either, nor the reverse.
 */
export const MESSAGE_BUTTON_CUSTOM_ID_PREFIX = 'mbtn';

/**
 * The custom_id a message's button is pressed by: `mbtn:<buttonKey>`, at most 69 characters.
 *
 * Only the button's key: the message arrives with the press (`interaction.message.id`), and
 * the message's binding names its journey and its key, so the id never has to fit both
 * into Discord's 100 characters.
 *
 * @throws when the id would be over Discord's limit — a key from somewhere other than a
 * checked declaration.
 */
export function messageButtonCustomId(buttonKey: string): string {
    const customId = `${MESSAGE_BUTTON_CUSTOM_ID_PREFIX}:${buttonKey}`;
    if (customId.length > DISCORD_CUSTOM_ID_MAX_LENGTH) {
        throw new Error(
            `Button key "${buttonKey}" makes a ${customId.length}-character button id, over Discord's ${DISCORD_CUSTOM_ID_MAX_LENGTH}.`
        );
    }
    return customId;
}

/**
 * The button key a custom_id names, or `null` when it is not exactly `mbtn:<key>`: another
 * prefix, a missing key, or a third segment. A key holds no colon, so anything with one more
 * is an id {@link messageButtonCustomId} did not build.
 */
export function parseMessageButtonCustomId(customId: string): string | null {
    const parts = customId.split(':');
    if (parts.length !== 2 || parts[0] !== MESSAGE_BUTTON_CUSTOM_ID_PREFIX) {
        return null;
    }
    return parts[1] || null;
}

/**
 * A message's buttons as Discord takes them: rows of five, in order, each pressed by its
 * {@link messageButtonCustomId}. No buttons is no rows, so an edit that removed them all
 * clears them.
 *
 * A button shows its label when it has one and its emoji when it has one. A server emoji is
 * shown only when `emojiIds` holds it: one deleted since it was picked, or from another
 * server the bot is in, is dropped and logged, and the button posts without it rather than
 * have Discord refuse the whole message. An emoji-only button that loses its emoji that way
 * posts `:name:` as its label, so it stays pressable and says what used to be there.
 *
 * @param emojiIds this server's emoji ({@link serverEmojiIds}), required so no caller can
 * drop every server emoji by forgetting it.
 * @throws past {@link MESSAGE_MAX_BUTTONS}, which the save refuses — Discord would refuse
 * the whole message.
 */
export function buildButtonRows(
    buttons: readonly MessageButton[],
    emojiIds: ReadonlySet<string>
): ActionRowBuilder<ButtonBuilder>[] {
    if (buttons.length > MESSAGE_MAX_BUTTONS) {
        throw new Error(`A message holds ${MESSAGE_MAX_BUTTONS} buttons, and this one has ${buttons.length}.`);
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let start = 0; start < buttons.length; start += DISCORD_BUTTONS_PER_ROW) {
        rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                buttons.slice(start, start + DISCORD_BUTTONS_PER_ROW).map((button) => buildButton(button, emojiIds))
            )
        );
    }
    return rows;
}

/** One button of {@link buildButtonRows}. */
function buildButton(button: MessageButton, emojiIds: ReadonlySet<string>): ButtonBuilder {
    const builder = new ButtonBuilder()
        .setCustomId(messageButtonCustomId(button.key))
        .setStyle(BUTTON_STYLE_MAP[button.style]);

    const { emoji } = button;
    const emojiShown = !!emoji && (!emoji.id || emojiIds.has(emoji.id));
    if (emoji?.id && !emojiShown) {
        console.warn(`[provisioning] posted button ${button.key} without its emoji ${emoji.id} — gone from the server`);
    }

    if (button.label) {
        builder.setLabel(button.label);
    } else if (emoji && !emojiShown) {
        builder.setLabel(emojiText(emoji));
    }
    if (emoji && emojiShown) {
        builder.setEmoji(
            emoji.id
                ? { id: emoji.id, name: emoji.name, ...(emoji.animated === undefined ? {} : { animated: emoji.animated }) }
                : { name: emoji.name }
        );
    }
    return builder;
}
