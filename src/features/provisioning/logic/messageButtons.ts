import { ActionRowBuilder, ButtonBuilder } from 'discord.js';
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
 * One button under a message.
 *
 * The **key** is its identity, as a resource's key is: unique within its message, it is what
 * a trigger will name and what the button's id carries, so renaming the label changes
 * nothing that listens to it.
 */
export interface MessageButton {
    /** Lowercase letters, digits and single hyphens, at most 64 characters — the resource key rule. */
    readonly key: string;
    /** 1–80 characters, Discord's limit. */
    readonly label: string;
    readonly style: MessageButtonStyle;
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
 * @throws past {@link MESSAGE_MAX_BUTTONS}, which the save refuses — Discord would refuse
 * the whole message.
 */
export function buildButtonRows(buttons: readonly MessageButton[]): ActionRowBuilder<ButtonBuilder>[] {
    if (buttons.length > MESSAGE_MAX_BUTTONS) {
        throw new Error(`A message holds ${MESSAGE_MAX_BUTTONS} buttons, and this one has ${buttons.length}.`);
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let start = 0; start < buttons.length; start += DISCORD_BUTTONS_PER_ROW) {
        rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                buttons
                    .slice(start, start + DISCORD_BUTTONS_PER_ROW)
                    .map((button) =>
                        new ButtonBuilder()
                            .setCustomId(messageButtonCustomId(button.key))
                            .setLabel(button.label)
                            .setStyle(BUTTON_STYLE_MAP[button.style])
                    )
            )
        );
    }
    return rows;
}
