import { z } from 'zod';
import { TICKET_TYPE_KEY_MAX_LENGTH, TICKET_TYPE_LABEL_MAX_LENGTH } from '../data/ticketingSchema';

/**
 * The rules a ticket type's key, label and channel-name template are held to, declared
 * once.
 *
 * Declared as zod rather than written as checks, so they travel: the web routes compose
 * these schemas into their requests (`ticketRoutes.ts` — the key in the path, the label and
 * template in the body; the template also through `TicketTypeSettings` in `ticketBody.ts`,
 * which a journey's declared ticket type carries), the OpenAPI spec carries each rule with
 * its sentence, and the dashboard's generated zod refuses a field with the same words the
 * server would. The sentences are therefore fixed text — one that named the bad value
 * could not be written into the spec.
 *
 * Plain zod on purpose: `src/features` imports neither hono nor `@hono/zod-openapi`.
 *
 * The two template rules that need the real renderer — that it renders to something, and
 * that its longest render fits a channel name — are not here. They are
 * `checkTicketTypeDefinition`'s (`setTicketTypes.ts`), and the browser learns them from the
 * refusal on save.
 */

/**
 * The only tokens `buildTicketChannelName` implements.
 *
 * **Change this and the renderer together.** The renderer substitutes each token by name
 * and does not read this list; a token listed here that it does not substitute would be
 * accepted and then reach Discord as literal braces. `ticketTypeRules.test.ts` renders
 * each one to hold the two together.
 */
export const SUPPORTED_TOKENS = ['####', 'subject', 'opener'] as const;

/**
 * The refusal for an over-long label. Fixed text built from the constant, so it travels to
 * the browser with the rule.
 */
export const TICKET_TYPE_LABEL_TOO_LONG_MESSAGE =
    `A label caps out at ${TICKET_TYPE_LABEL_MAX_LENGTH} characters — ` +
    'the mod ticket picker in Discord will not show more. Keep it snappy.';

/**
 * A ticket type's key: the identity every ticket of the type points at.
 *
 * Restricted rather than merely non-blank, because the key reaches a channel name and a
 * flow `select` value. Trimmed first, so a padded key is stored as the key every lookup
 * will use — validating the trimmed key and storing the untrimmed one would leave a type
 * in the config that every lookup misses.
 */
export const TicketTypeKeySchema = z
    .string()
    .trim()
    .min(1, 'A ticket type needs a key. Blank is not a category of anything.')
    .max(
        TICKET_TYPE_KEY_MAX_LENGTH,
        `Keep the key to ${TICKET_TYPE_KEY_MAX_LENGTH} characters or fewer. It is an identifier, not a confession.`
    )
    .regex(
        /^[a-z0-9_-]+$/,
        'That will not do as a key — lowercase letters, digits, `-` and `_` only. The label is where you get to be expressive.'
    );

/**
 * What an operator picks the type out of a list by. Capped at
 * `TICKET_TYPE_LABEL_MAX_LENGTH` (45), the builders' limit on an option in the mod ticket
 * modal's select — a longer label makes `showModal` throw.
 */
export const TicketTypeLabelSchema = z
    .string()
    .trim()
    .min(1, 'Give the type a label — operators have to pick it out of a list.')
    .max(TICKET_TYPE_LABEL_MAX_LENGTH, TICKET_TYPE_LABEL_TOO_LONG_MESSAGE);

/** A regex-literal copy of `text`, so a token is matched as written. */
function escapeForPattern(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A template made only of characters that are not braces and of known tokens, each with
 * exactly two braces either side.
 *
 * One pattern for what used to be two checks — an unknown token, and a brace left over
 * after rendering — because both come down to "a brace outside a known token". Built from
 * {@link SUPPORTED_TOKENS}, so the pattern and the sentence follow the list. No flags: the
 * spec cannot carry them.
 */
const TEMPLATE_PATTERN = new RegExp(
    `^(?:[^{}]|\\{\\{(?:${SUPPORTED_TOKENS.map(escapeForPattern).join('|')})\\}\\})*$`
);

/** "`{{a}}`, `{{b}}` and `{{c}}`", for the sentence below. */
function listTokens(tokens: readonly string[]): string {
    const written = tokens.map((token) => `\`{{${token}}}\``);
    return written.length > 1 ? `${written.slice(0, -1).join(', ')} and ${written.at(-1)}` : written.join('');
}

/**
 * A channel-name template.
 *
 * The pattern is why `S{{####}}-{{user}}-{{creator}}` — tokens nothing implemented,
 * accepted, stored, shown to operators and then silently dropped — is refused, and why
 * `{{subject}` is: Discord would strip the brace and name the channel after the word.
 */
export const TicketNameTemplateSchema = z
    .string()
    .trim()
    .min(1, 'A channel-name template cannot be empty. Discord insists on calling channels something.')
    .regex(
        TEMPLATE_PATTERN,
        `Only ${listTokens(SUPPORTED_TOKENS)} render here, each with exactly two braces either side — nothing else, and no, wishing does not count.`
    );

/**
 * The three rules together, for a caller holding a whole definition rather than a request
 * split into path and body — `checkTicketTypeDefinition` (`setTicketTypes.ts`), behind
 * `upsertTicketType`, `createTicketTypeIfAbsent` and the journey save, so a surface that
 * calls those directly is held to the same rules the route is. Parsing normalizes: the
 * key, label and template come back trimmed.
 */
export const TicketTypeRulesSchema = z.object({
    type: TicketTypeKeySchema,
    label: TicketTypeLabelSchema,
    nameTemplate: TicketNameTemplateSchema,
});
