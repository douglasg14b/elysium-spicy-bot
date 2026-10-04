import { z } from 'zod';

/**
 * The rules a ticket type's key, label and channel-name template are held to, declared
 * once.
 *
 * Declared as zod rather than written as checks, so they travel: the web route composes
 * these schemas into its request (`ticketRoutes.ts` — the key in the path, the label and
 * template in the body), the OpenAPI spec carries each rule with its sentence, and the
 * dashboard's generated zod refuses a field with the same words the server would. The
 * sentences are therefore fixed text — one that named the bad value could not be written
 * into the spec.
 *
 * Plain zod on purpose: `src/features` imports neither hono nor `@hono/zod-openapi`.
 *
 * The two template rules that need the real renderer — that it renders to something, and
 * that its longest render fits a channel name — are not here. They stay in
 * `upsertTicketType`, and the browser learns them from the refusal on save.
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
    .regex(
        /^[a-z0-9_-]+$/,
        'That will not do as a key — lowercase letters, digits, `-` and `_` only. The label is where you get to be expressive.'
    );

/** What an operator picks the type out of a list by. */
export const TicketTypeLabelSchema = z
    .string()
    .trim()
    .min(1, 'Give the type a label — operators have to pick it out of a list.');

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
 * split into path and body — `upsertTicketType`, so a surface that calls it directly is
 * held to the same rules the route is. Parsing normalizes: the key, label and template
 * come back trimmed.
 */
export const TicketTypeRulesSchema = z.object({
    type: TicketTypeKeySchema,
    label: TicketTypeLabelSchema,
    nameTemplate: TicketNameTemplateSchema,
});
