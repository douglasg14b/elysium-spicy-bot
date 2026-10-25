import { ButtonStyle } from 'discord.js';

/**
 * Discord's rules for the buttons the bot puts under a message, shared by everything that
 * builds one: flows' trigger and question buttons, and provisioning's message resource.
 *
 * Here rather than in either feature because provisioning may not import flows, and both
 * build buttons against the same limits.
 */

/**
 * Discord's hard cap on a component `custom_id`, in characters.
 *
 * Load-bearing rather than documentation: whatever builds an id that would exceed it must
 * refuse while building the message, naming what it was building, rather than have Discord
 * reject the whole post at send time with a validation error that names none of it.
 */
export const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;

/**
 * Discord's hard cap on a button's visible label, in characters.
 *
 * Held by schemas rather than trusted: Discord rejects the whole message when a label is
 * over, so an author who pastes a sentence would otherwise find out when the post fails
 * instead of on a save they can fix.
 */
export const DISCORD_BUTTON_LABEL_MAX_LENGTH = 80;

/** Discord's limit on buttons in one action row. A hard API error, not advice. */
export const DISCORD_BUTTONS_PER_ROW = 5;

/** Discord's limit on buttons under one message: five rows of five. */
export const DISCORD_MAX_BUTTONS_PER_MESSAGE = 5 * DISCORD_BUTTONS_PER_ROW;

/**
 * The button styles the bot's own buttons take, in the order a picker offers them: every
 * style that answers a press. Not Link, which opens a URL and tells the bot nothing, and not
 * Premium, which sells something.
 */
export const BUTTON_STYLES = ['Primary', 'Secondary', 'Success', 'Danger'] as const;
export type ButtonStyleName = (typeof BUTTON_STYLES)[number];

/** Each of {@link BUTTON_STYLES} as discord.js names it. */
export const BUTTON_STYLE_MAP: Record<ButtonStyleName, ButtonStyle> = {
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger,
};
