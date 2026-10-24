import { describe, expect, it } from 'vitest';
import {
    MESSAGE_TOTAL_CHARACTERS,
    messageCharacterCount as browserCount,
} from '../../../../web/src/flows/messageEditor/messageCharacters';
import {
    EMBED_TEXT_KINDS,
    partLabel,
    partPath,
    PICTURE_KINDS,
    type PicturePart,
    type TextPart,
} from '../../../../web/src/flows/messageEditor/messageDraft';
import { MESSAGE_LIMITS } from '../messageLimits';
import { messageCharacterCount, messageCopyLocations, messagePictures } from '../messageParts';

/**
 * The drift gates between the message window and the server: its character meter against the
 * rule a save judges, and (below) its paths and names for the parts against the server's.
 *
 * The meter's total and its count are a hand-written mirror (`messageCharacters.ts`): the
 * total spans parts, so no part's rule in the spec can carry it to the browser. Both
 * directions mislead an author. A meter counting more than the save would go red on a
 * message the save takes; one counting less would sit comfortably green on a message every
 * save refuses with "over 6000 characters".
 *
 * Counts are compared, not just the constant: the rule is which parts count and that the
 * text inside `{{tokens}}` does not, and a mirror with the right number and the wrong parts
 * would pass a check on the number alone.
 */

const REMEDY =
    'Reconcile `web/src/flows/messageEditor/messageCharacters.ts` with `MESSAGE_LIMITS.totalCharacters` ' +
    "and `messageCharacterCount(message, 'outsideTokens')` in `src/shared/discordMessage/`.";

const MESSAGES: readonly (readonly [string, Parameters<typeof browserCount>[0]])[] = [
    ['nothing at all', { embeds: [] }],
    ['plain text alone, which Discord does not count', { content: 'x'.repeat(1500), embeds: [] }],
    [
        'every counted part of one embed',
        {
            embeds: [
                {
                    author: { name: 'The Management', iconUrl: 'https://cdn.example/a.png' },
                    title: 'House rules',
                    url: 'https://example.com/rules',
                    description: 'Read them. Then read them again.',
                    fields: [
                        { name: 'Age', value: '18+, no exceptions', inline: true },
                        { name: 'Safewords', value: 'Red / Yellow' },
                    ],
                    footer: { text: 'Behave yourselves.', iconUrl: 'upload:7d4f3b52-9a51-4a7b-8f53-0f6c5b0d2c11' },
                    image: 'https://cdn.example/banner.png',
                    thumbnail: 'https://cdn.example/logo.png',
                    timestamp: true,
                },
            ],
        },
    ],
    [
        'tokens, whose text a save does not count',
        {
            embeds: [
                { title: 'Hey {{subject.mention}}', description: '{{ var.pick }} wins, {{guild.name}} loses' },
                { footer: { text: '{{subject.username}}' }, fields: [{ name: '{{var.a}}', value: 'b {{actor.mention}}' }] },
            ],
        },
    ],
    [
        'unclosed braces, which are text',
        { embeds: [{ title: '{{not a token', description: '}} nor this {{' }] },
    ],
];

describe('the message meter against the save', () => {
    it('stops at the total a save judges', () => {
        expect(MESSAGE_TOTAL_CHARACTERS, REMEDY).toBe(MESSAGE_LIMITS.totalCharacters);
    });

    it.each(MESSAGES)('counts %s as a save does', (_name, message) => {
        expect(browserCount(message), REMEDY).toBe(messageCharacterCount(message, 'outsideTokens'));
    });
});

/**
 * The window marks a part by the path a complaint names (`messageIssues.ts`), and a run's
 * refusal names a part by the server's words for it — so the window's path and name for each
 * part must be the server's. A path that drifted would leave a complaint listed above the
 * message instead of on its part; a name that drifted would send the author looking for a part
 * the window calls something else.
 */
describe("the message window's parts against the server's", () => {
    const PARTS_REMEDY =
        'Reconcile `partPath` / `partLabel` in `web/src/flows/messageEditor/messageDraft.ts` with `messageParts` ' +
        'in `src/shared/discordMessage/messageParts.ts`.';

    // Every part filled, two embeds and two fields each, so the numbering is tested too.
    const embed = {
        author: { name: 'n', iconUrl: 'https://cdn.example/a.png' },
        title: 't',
        url: 'https://example.com',
        description: 'd',
        thumbnail: 'https://cdn.example/t.png',
        fields: [
            { name: 'a', value: 'b' },
            { name: 'c', value: 'd' },
        ],
        image: 'https://cdn.example/i.png',
        footer: { text: 'f', iconUrl: 'https://cdn.example/f.png' },
    };
    const message = { content: 'c', embeds: [embed, embed] };

    function windowParts(): ReadonlyMap<string, string> {
        const parts: (TextPart | PicturePart)[] = [{ kind: 'content' }];
        message.embeds.forEach((each, index) => {
            parts.push(...EMBED_TEXT_KINDS.map((kind) => ({ kind, embed: index })));
            parts.push(...PICTURE_KINDS.map((kind) => ({ kind, embed: index })));
            each.fields.forEach((_field, field) => {
                parts.push({ kind: 'fieldName', embed: index, field }, { kind: 'fieldValue', embed: index, field });
            });
        });
        return new Map(parts.map((part) => [partPath(part), partLabel(part).toLowerCase()]));
    }

    const serverParts = new Map(
        [...messageCopyLocations(message), ...messagePictures(message)].map((part) => [part.path.join('.'), part.where.toLowerCase()])
    );

    it('addresses and names every part the server names as the server does', () => {
        const drawn = windowParts();
        for (const [path, where] of serverParts) {
            expect(drawn.get(path), `${path}: ${PARTS_REMEDY}`).toBe(where);
        }
    });

    it('draws no part the server has no name for, but the title link', () => {
        // The title's link is never filled in at run time, so the server has nothing to say about it by name.
        const unnamed = [...windowParts().keys()].filter((path) => !serverParts.has(path));
        expect(unnamed, PARTS_REMEDY).toEqual(['embeds.0.url', 'embeds.1.url']);
    });
});
