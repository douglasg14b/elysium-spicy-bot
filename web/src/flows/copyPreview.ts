/**
 * What a piece of authored copy will look like once the engine fills it in.
 *
 * A token is written in one place and read in another, and between them the author
 * is asked to picture the result. `Welcome {{subject.username}}, {{guild.name}}
 * has you` is legible; a ticket title three tokens deep is not, and the block card
 * shows the raw template too — so nowhere in the builder answers "what will this
 * actually say".
 *
 * Every stand-in below is a lowercase English phrase no real username or server
 * name would plausibly be, so the preview cannot be mistaken for live data. That
 * is the whole design constraint: the browser has no guild and no member, and a
 * preview that *looked* resolved would be a preview of a run that never happened.
 */

import type { BuiltinTokenName } from './builtinTokens';
import { TOKEN_PATTERN, tokensIn, variableNameOf } from './variables';

/** Why one token could not be shown as a finished value. */
export type PreviewTokenProblem =
    /** Not a token the engine resolves — the braces will be sent as written. */
    | 'unknownToken'
    /** A `{{var.…}}` no block above this one writes. */
    | 'unwrittenVariable';

export interface PreviewProblem {
    /** The token as the author wrote it, contents trimmed. */
    readonly token: string;
    readonly problem: PreviewTokenProblem;
}

export interface CopyPreview {
    /** The copy with every resolvable token replaced by a stand-in. */
    readonly text: string;
    /** What the preview could not show honestly, in the order written. */
    readonly problems: readonly PreviewProblem[];
}

/**
 * What each built-in token stands in as.
 *
 * `@` is kept only where a real ping appears, so the preview's shape matches the
 * sent message's. No stand-in is longer than a plausible real value — a preview
 * that exaggerated length would argue with the character-limit hint on the same
 * field, which counts the rendered string.
 */
const BUILTIN_STAND_INS: Readonly<Record<BuiltinTokenName, string>> = {
    'subject.mention': '@someone',
    'subject.username': 'someone',
    // Distinguished from the subject on purpose: the two are the same person on
    // most runs, and an author who has not noticed they are different concepts is
    // exactly who this preview is for.
    'actor.mention': '@whoever did this',
    'guild.name': 'this server',
};

/**
 * Whether a token name is one the engine fills in.
 *
 * `Object.hasOwn`, never `in`: `in` walks the prototype chain, so `{{toString}}`
 * would be "recognised" and previewed as a value — the same trap the engine's own
 * resolver documents at length, and the same answer.
 */
function isBuiltinTokenName(token: string): token is BuiltinTokenName {
    return Object.hasOwn(BUILTIN_STAND_INS, token);
}

/**
 * Preview one authored string.
 *
 * Unknown tokens are left **verbatim**, braces and all, and reported. That is the
 * one case where showing the author what they wrote is more useful than showing
 * them a value: a stand-in would make broken copy look finished, and the run that
 * refuses it is hours away.
 *
 * A `{{var.…}}` nothing writes still previews as `[name]` — it is reported here so
 * the decision is testable, but the picker beneath already warns about it in
 * yellow, and two warnings for one mistake read as two mistakes.
 */
export function previewCopy(copy: string, knownVariables: readonly string[]): CopyPreview {
    const known = new Set(knownVariables);
    const problems: PreviewProblem[] = [];
    const seen = new Set<string>();

    const text = copy.replace(TOKEN_PATTERN, (whole, rawToken: string) => {
        const token = rawToken.trim();

        if (isBuiltinTokenName(token)) {
            return BUILTIN_STAND_INS[token];
        }

        const variable = variableNameOf(token);
        if (variable) {
            // Square brackets read as "fill in the blank" and cannot be mistaken
            // for a value, and keeping the author's own name visible is what lets
            // them spot the typo the picker is warning about underneath.
            if (known.has(variable)) {
                return `[${variable}]`;
            }

            if (!seen.has(token)) {
                seen.add(token);
                problems.push({ token, problem: 'unwrittenVariable' });
            }

            /*
             * Marked, because the engine treats this as fatally as an unknown
             * token and a clean `[name]` would read as finished. The picker below
             * carries the only *sentence* about it — one mistake, one warning —
             * but the preview must not quietly disagree with that warning by
             * showing the copy as though it would send.
             */
            return `[${variable}: nothing writes this]`;
        }

        if (!seen.has(token)) {
            seen.add(token);
            problems.push({ token, problem: 'unknownToken' });
        }
        return whole;
    });

    return { text, problems };
}

/**
 * Whether previewing this copy would tell the author anything the field does not.
 *
 * Copy with no tokens previews as itself, so showing it would put a second copy of
 * the field's own contents under every plain-text field in the builder. The
 * preview earns its line only once there is something in the string that the
 * author cannot read directly.
 */
export function hasPreviewableTokens(copy: string): boolean {
    return tokensIn(copy).length > 0;
}
