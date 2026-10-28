import { z } from 'zod';
import { DISCORD_BUTTON_LABEL_MAX_LENGTH } from '../../../shared/discordButtons';
import { RESOURCE_KEY_MAX_LENGTH, RESOURCE_KEY_PATTERN } from '../../../shared/resourceKey';
import {
    MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH,
    MESSAGE_BUTTON_STYLES,
    MESSAGE_MAX_BUTTONS,
} from './messageButtons';
import { messageButtonProblems } from './messageResourceProblems';

/**
 * The sentence each of a button's own rules is refused with — one set, so a journey message's
 * buttons (`MessageButtonSchema` in `src/web/api/journeyBody.ts`, the wire) and a block's
 * ({@link messageButtonsConfigSchema}) say the same thing about the same button. The wire
 * builds its schema with `@hono/zod-openapi`'s `z` for the spec, so the two schemas are
 * written twice; their words are not.
 */
export const MESSAGE_BUTTON_RULE_SENTENCES = {
    keyMissing: 'Give the button a key.',
    keyTooLong: `Button keys cap at ${RESOURCE_KEY_MAX_LENGTH} characters.`,
    keyShape: 'Button keys use lowercase letters, numbers and single hyphens (for example `let-me-in`).',
    labelBlank: "A button's label can't be blank — write one, or leave it off and let the emoji talk.",
    labelTooLong: `Button labels stop at ${DISCORD_BUTTON_LABEL_MAX_LENGTH} characters — Discord's rule, not ours.`,
    emojiNameMissing: 'An emoji needs a name.',
    emojiNameTooLong: `Emoji names stop at ${MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH} characters.`,
    emojiIdShape: "A server emoji's id is 17 to 20 digits.",
    tooMany: `A message holds ${MESSAGE_MAX_BUTTONS} buttons, tops — five rows of five.`,
} as const;

/** A server emoji's id, as the wire takes one. */
export const SERVER_EMOJI_ID_PATTERN = /^\d{17,20}$/;

const sentences = MESSAGE_BUTTON_RULE_SENTENCES;

/** One button, field by field — the wire's `MessageButton`, in plain zod. */
const messageButtonConfigSchema = z.object({
    key: z
        .string()
        .min(1, sentences.keyMissing)
        .max(RESOURCE_KEY_MAX_LENGTH, sentences.keyTooLong)
        .regex(new RegExp(`^${RESOURCE_KEY_PATTERN}$`), sentences.keyShape),
    label: z.string().min(1, sentences.labelBlank).max(DISCORD_BUTTON_LABEL_MAX_LENGTH, sentences.labelTooLong).optional(),
    style: z.enum(MESSAGE_BUTTON_STYLES),
    emoji: z
        .object({
            name: z.string().min(1, sentences.emojiNameMissing).max(MESSAGE_BUTTON_EMOJI_NAME_MAX_LENGTH, sentences.emojiNameTooLong),
            id: z.string().regex(SERVER_EMOJI_ID_PATTERN, sentences.emojiIdShape).optional(),
            animated: z.boolean().optional(),
        })
        .optional(),
});

/**
 * The buttons under a block's message, as a block's config holds them beside its `message`
 * key (the `message` field's `buttonsKey`): up to {@link MESSAGE_MAX_BUTTONS}, each with a
 * label or an emoji, an emoji that is one, no `{{tokens}}` in a label and a key of its own —
 * {@link messageButtonProblems}, the rules a journey message's buttons are saved under too.
 * A label takes no tokens on a block either: the executor renders copy by the `message`
 * control's walk, which never reaches a sibling key, so a token would post braces and all.
 *
 * The refinement stays out of the browser's field rules, as `messageConfigSchema`'s does:
 * the buttons are no drawn field of their own, so nothing exports them, and the server's
 * re-check carries every sentence. Each problem is placed on its button (`buttons.2`).
 *
 * **Asked only once every button's own fields pass**, as the journey route asks
 * `messageResourceProblems` only once its schema has: a pipe, because zod runs a refinement
 * over a list whose entries already failed a length rule, and a blank label would then be
 * refused twice — for being blank, and for leaving nothing to press.
 */
const messageButtonListSchema = z.array(messageButtonConfigSchema).max(MESSAGE_MAX_BUTTONS, sentences.tooMany);

/** A block's buttons as its `run` receives them — `MessageButton`s, which `buildButtonRows` takes. */
export type MessageButtonsConfig = z.output<typeof messageButtonListSchema>;

export const messageButtonsConfigSchema = messageButtonListSchema.pipe(
    z.custom<MessageButtonsConfig>().superRefine((buttons, context) => {
        for (const problem of messageButtonProblems(buttons)) {
            context.addIssue({ code: 'custom', path: [problem.index], message: problem.message });
        }
    })
);
