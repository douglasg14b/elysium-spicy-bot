/**
 * Where the server's complaints about a message go in the window.
 *
 * Each complaint arrives with its path inside the message (`embeds.1.title`). One naming a
 * part the window draws marks that part; one naming an embed, or something inside it the
 * window has no box for (`embeds.0.fields`, too many of them), sits under that embed; and
 * anything else is listed above the message. **Nothing is dropped** — the same rule
 * `placeIssues` keeps for the inspector.
 */

import type { NestedIssue } from '../controls/types';
import { EMBED_TEXT_KINDS, partPath, PICTURE_KINDS, type MessageDraft, type PicturePart, type TextPart } from './messageDraft';

export interface PlacedMessageIssues {
    /** By a drawn part's path, every sentence about it. */
    readonly byPart: ReadonlyMap<string, readonly string[]>;
    /** By embed position, every sentence about the embed or a part of it with no box. */
    readonly byEmbed: ReadonlyMap<number, readonly string[]>;
    /** Everything else: about the message as a whole, or an embed it no longer has. */
    readonly rest: readonly string[];
}

/** The path of every part the window draws for `message`, empty ones included. */
function drawnPaths(message: MessageDraft): ReadonlySet<string> {
    const paths = new Set<string>([partPath({ kind: 'content' })]);
    message.embeds.forEach((embed, index) => {
        const parts: (TextPart | PicturePart)[] = [
            ...EMBED_TEXT_KINDS.map((kind) => ({ kind, embed: index })),
            ...PICTURE_KINDS.map((kind) => ({ kind, embed: index })),
            ...(embed.fields ?? []).flatMap((_field, field) => [
                { kind: 'fieldName' as const, embed: index, field },
                { kind: 'fieldValue' as const, embed: index, field },
            ]),
        ];
        for (const part of parts) paths.add(partPath(part));
    });
    return paths;
}

const EMBED_PATH = /^embeds\.(\d+)(?:\.|$)/;

export function placeMessageIssues(issues: readonly NestedIssue[], message: MessageDraft): PlacedMessageIssues {
    const drawn = drawnPaths(message);
    const byPart = new Map<string, string[]>();
    const byEmbed = new Map<number, string[]>();
    const rest: string[] = [];

    for (const issue of issues) {
        if (drawn.has(issue.path)) {
            byPart.set(issue.path, [...(byPart.get(issue.path) ?? []), issue.message]);
            continue;
        }
        const embed = Number(EMBED_PATH.exec(issue.path)?.[1] ?? Number.NaN);
        if (Number.isInteger(embed) && embed < message.embeds.length) {
            byEmbed.set(embed, [...(byEmbed.get(embed) ?? []), issue.message]);
            continue;
        }
        rest.push(issue.message);
    }

    return { byPart, byEmbed, rest };
}
