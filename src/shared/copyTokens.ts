/**
 * Everything `{{…}}` could contain in authored copy, matched permissively on purpose.
 *
 * Deliberately **not** narrowed to the tokens that resolve: an unknown token has to be
 * *seen* in order to be rejected by name. A pattern matching only valid tokens would leave
 * `{{subject.foo}}` as ordinary text, which would then be sent to a member with its braces
 * intact.
 *
 * Inner whitespace is tolerated (`{{ subject.mention }}`) because an author will type it.
 *
 * Here rather than in the flow engine's renderer (`features/flows/engine/copyRendering.ts`,
 * which uses it), because a message's picture reader in `src/shared/discordMessage` must
 * see a token exactly where the renderer does, and nothing under `src/shared` imports a
 * feature. Global: use it with `replace`/`matchAll`, and {@link holdsCopyToken} to ask.
 */
export const COPY_TOKEN_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The same pattern without the global flag, so a `.test` carries no `lastIndex` between calls. */
const ONE_COPY_TOKEN = new RegExp(COPY_TOKEN_PATTERN.source);

/** Whether text holds at least one `{{…}}` token, known or not. */
export function holdsCopyToken(text: string): boolean {
    return ONE_COPY_TOKEN.test(text);
}
