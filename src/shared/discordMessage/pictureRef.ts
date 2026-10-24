import { z } from 'zod';
import { holdsCopyToken } from '../copyTokens';

/**
 * A picture on a message, as one string: an uploaded picture (`upload:<uuid>`), an http(s)
 * link, or text holding a `{{token}}` that becomes a link once the run fills it in.
 *
 * One string rather than an object per kind, so a link or a token written before uploads
 * existed is already a picture, and copy rendering can treat the string as copy: an upload
 * ref holds no braces, so it passes through untouched. {@link parsePictureRef} is the only
 * reader of the form.
 */

/**
 * A link Discord will put on an embed: `http://` or `https://` in any case, a host, and no
 * whitespace.
 *
 * A pattern rather than zod's `.url()`, because it is shared with the wire schema the
 * browser checks against: a pattern travels to the browser exactly, a URL format does not.
 * No flags, for the same reason — the spec cannot carry them — so the scheme's case is
 * spelled out (`Https://` is what a phone keyboard writes).
 */
export const HTTP_LINK_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s/?#]+\S*$/;

/** An upload's id, as `randomUUID` writes it. */
const UPLOAD_REF_PATTERN = /^upload:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Whether a link is one discord.js will take — a picture's, or a title's: the shared pattern,
 * and a URL that parses — `https://a%zz/x.png` passes the pattern and makes the embed builder
 * throw. Server-only, so it can go further than what the browser is given.
 */
export function isUsableLink(value: string): boolean {
    return HTTP_LINK_PATTERN.test(value) && URL.canParse(value);
}

/** What one picture string is. */
export type PictureRef =
    | { readonly kind: 'upload'; readonly uploadId: string }
    | { readonly kind: 'link'; readonly url: string }
    | { readonly kind: 'token'; readonly text: string };

/**
 * What a picture string is, or `undefined` for one that is none of the three.
 *
 * Read in this order: an upload ref first (it is exact), then text holding a token — a link
 * with a token inside it (`https://cdn/{{var.pic}}.png`) is judged once it is filled in —
 * then a plain link. Any token counts, known or not: an unknown one is refused by the
 * save-time token check, by name, which is a better sentence than this could give it.
 */
export function parsePictureRef(value: string): PictureRef | undefined {
    const upload = UPLOAD_REF_PATTERN.exec(value);
    if (upload?.[1]) {
        return { kind: 'upload', uploadId: upload[1] };
    }
    if (holdsCopyToken(value)) {
        return { kind: 'token', text: value };
    }
    if (isUsableLink(value)) {
        return { kind: 'link', url: value };
    }
    return undefined;
}

/**
 * A picture as a block's schema takes it: an upload ref, a link, or text with a token.
 *
 * Refined, so it stays on the block's side: the wire's `DiscordMessage` takes a plain
 * string in its place, since a request schema cannot carry a refinement to the browser.
 */
export const pictureRefSchema = z
    .string()
    .refine(
        (value) => parsePictureRef(value) !== undefined,
        'A picture takes an upload, a full http:// or https:// link, or a token like {{subject.avatarUrl}}.'
    );

/**
 * Why a picture is unusable once its tokens are filled in, or `undefined` when it is a link.
 *
 * The second half of {@link pictureRefSchema}: a token can turn into anything — `{{var.pick}}`
 * might hold a word — and discord.js throws out of the builder on a malformed link, which
 * would fail a run for no reason it names. Asked only of a picture that was copy (one that is
 * not an upload), after rendering.
 *
 * @param where - The part, as an author finds it: `"Message" embed 1 image`.
 */
export function renderedPictureProblem(where: string, rendered: string | undefined): string | undefined {
    if (rendered === undefined || isUsableLink(rendered)) {
        return undefined;
    }
    return (
        `${where} came out as "${rendered}" once its tokens were filled in, which is not a link ` +
        'Discord can show. Use a token that holds a full http:// or https:// URL, like {{subject.avatarUrl}}.'
    );
}
