import { describe, expect, it } from 'vitest';
import type { ResourceDeclaration as BrowserResourceDeclaration } from '@brattybot/web-sdk';
import { messageResourceProblems as browserProblems } from '../../../../../web/src/flows/messageResourceProblems';
import { ResourceDeclarationSchema } from '../../../../web/api/journeyBody';
import { messageResourceProblems } from '../messageResourceProblems';

/**
 * The browser's judgement of a message resource against the server's, over one table.
 *
 * `web/src/flows/messageResourceProblems.ts` decides whether the Resources list may be saved:
 * while it reports anything, the autosave holds and the row wears a red chip quoting its first
 * sentence. Both directions mislead. A rule the mirror lacks sends a save the server refuses,
 * and the refusal re-reads the stored list over the window the author is typing in — the revert
 * the hold exists to stop. A rule the mirror invents holds a list the server would take, with a
 * chip quoting a sentence the server never says.
 *
 * So each row is judged by both, and they must report the same problems, in the same order,
 * worded the same and naming the same part:
 *
 *  - **the schema stage**: `ResourceDeclarationSchema`, which the route parses before anything
 *    else — compared by path and sentence, since a schema refusal names no part;
 *  - **then** `messageResourceProblems`, which the route asks once the schema passes — compared
 *    by part (`where`) and sentence.
 *
 * Not in the table: a link that fits the pattern but does not parse (`https://a%zz/x`), which
 * the mirror leaves to the server on purpose, and the uploads, which need this server's sizes.
 */

const UPLOAD = 'upload:7d4f3b52-9a51-4a7b-8f53-0f6c5b0d2c11';
const SERVER_EMOJI_ID = '112233445566778899';

type Message = NonNullable<BrowserResourceDeclaration['message']>;
type Buttons = NonNullable<BrowserResourceDeclaration['buttons']>;
type Embed = Message['embeds'][number];

const RULES: Embed = { title: 'House rules', description: 'Be filthy, be kind.', footer: { text: 'The management' } };
const SAFEWORDS: Embed = { title: 'Safewords', footer: { text: 'Red means stop' } };
const BUTTONS: Buttons = [
    { key: 'let-me-in', label: 'Let me in', style: 'Success' },
    { key: 'nope', label: 'Nope', style: 'Danger' },
];

function panel(message: Message, buttons: Buttons = BUTTONS): BrowserResourceDeclaration {
    return { key: 'rules-panel', kind: 'message', defaultName: 'Rules panel', parentKey: 'rules', message, buttons };
}

const withSecond = (embed: Embed, content?: string): Message => ({ ...(content ? { content } : {}), embeds: [RULES, embed] });

const TABLE: readonly (readonly [string, BrowserResourceDeclaration])[] = [
    ['a clean message with buttons', panel(withSecond(SAFEWORDS, 'Read these first.'))],
    ['a clean message with no buttons at all', { ...panel(withSecond(SAFEWORDS)), buttons: undefined }],
    [
        'every picture form the server takes',
        panel(
            withSecond({
                ...SAFEWORDS,
                author: { name: 'The Management', iconUrl: UPLOAD },
                thumbnail: 'https://cdn.example.com/logo.png',
                image: 'HTTPS://cdn.example.com/banner.png',
                footer: { text: 'Behave', iconUrl: UPLOAD },
            })
        ),
    ],

    // --- the schema's own rules, part by part ---
    ['a title one over 256', panel(withSecond({ ...SAFEWORDS, title: 'x'.repeat(257) }))],
    ['an emptied title', panel(withSecond({ ...SAFEWORDS, title: '' }))],
    ['a title link that is not a link', panel(withSecond({ ...SAFEWORDS, url: 'rules page' }))],
    [
        'two parts of one embed over, in the order the server meets them',
        panel(withSecond({ ...SAFEWORDS, title: 'x'.repeat(257), description: 'y'.repeat(4097), footer: { text: 'z'.repeat(2049) } })),
    ],
    ['plain text over 2000 and a field heading over 256', panel({ content: 'x'.repeat(2001), embeds: [{ fields: [{ name: 'h'.repeat(257), value: 'v' }] }] })],
    ['eleven embeds', panel({ embeds: Array.from({ length: 11 }, (_unused, index) => ({ title: `Embed ${index + 1}` })) })],
    ['a colour that is not a hex value', panel(withSecond({ ...SAFEWORDS, color: 'pink' }))],
    ['26 buttons', panel(withSecond(SAFEWORDS), Array.from({ length: 26 }, (_unused, index) => ({ key: `b${index}`, label: `B${index}`, style: 'Primary' as const })))],
    ['a button key with an underscore', panel(withSecond(SAFEWORDS), [{ key: 'let_me_in', label: 'Let me in', style: 'Success' }])],
    ['a button with a blank label', panel(withSecond(SAFEWORDS), [{ key: 'blank', label: '', style: 'Secondary' }])],
    ['a button label of 81', panel(withSecond(SAFEWORDS), [{ key: 'long', label: 'x'.repeat(81), style: 'Primary' }])],
    ['a server emoji id that is not one', panel(withSecond(SAFEWORDS), [{ key: 'love', style: 'Primary', emoji: { id: '12', name: 'blobheart' } }])],
    ['an emoji name of 33', panel(withSecond(SAFEWORDS), [{ key: 'love', style: 'Primary', emoji: { name: 'x'.repeat(33) } }])],
    [
        'a blank label and a bad emoji on one button, in the order the server meets them',
        panel(withSecond(SAFEWORDS), [{ key: 'love', label: '', style: 'Primary', emoji: { id: '12', name: '' } }]),
    ],

    // --- each button has something to press ---
    ['an emoji-only button', panel(withSecond(SAFEWORDS), [{ key: 'spicy', style: 'Danger', emoji: { name: '🌶️' } }])],
    [
        'a server emoji, animated, beside a label',
        panel(withSecond(SAFEWORDS), [
            { key: 'love', label: 'Love', style: 'Primary', emoji: { id: SERVER_EMOJI_ID, name: 'blob_heart', animated: true } },
        ]),
    ],
    ['a flag, a keycap and a ZWJ sequence', panel(withSecond(SAFEWORDS), [
        { key: 'flag', style: 'Primary', emoji: { name: '🇬🇧' } },
        { key: 'one', style: 'Primary', emoji: { name: '1️⃣' } },
        { key: 'pride', style: 'Primary', emoji: { name: '🏳️‍🌈' } },
    ])],
    ['a button with neither a label nor an emoji', panel(withSecond(SAFEWORDS), [BUTTONS[0], { key: 'blank', style: 'Secondary' }] as Buttons)],
    ['a letter in a keycap and a lone regional indicator', panel(withSecond(SAFEWORDS), [
        { key: 'kx', style: 'Primary', emoji: { name: 'x⃣' } },
        { key: 'ra', style: 'Primary', emoji: { name: '🇦' } },
    ])],
    ['two emoji where one goes',panel(withSecond(SAFEWORDS), [{ key: 'spicy', style: 'Danger', emoji: { name: '🌶️🌶️' } }])],
    ['a word where a standard emoji goes', panel(withSecond(SAFEWORDS), [{ key: 'fire', label: 'Fire', style: 'Danger', emoji: { name: 'fire' } }])],
    ['a server emoji named with a hyphen', panel(withSecond(SAFEWORDS), [{ key: 'love', style: 'Primary', emoji: { id: SERVER_EMOJI_ID, name: 'blob-heart' } }])],
    ['an animated standard emoji', panel(withSecond(SAFEWORDS), [{ key: 'spicy', style: 'Danger', emoji: { name: '🌶️', animated: true } }])],

    // --- the message as Post Embed takes it ---
    ['a half-typed picture link', panel(withSecond({ ...SAFEWORDS, thumbnail: 'ht' }))],
    ['an upload ref that is not an upload', panel(withSecond({ ...SAFEWORDS, image: 'upload:not-a-uuid' }))],
    ['an empty embed', panel(withSecond({}))],
    ['a lone footer icon', panel(withSecond({ title: 'Safewords', footer: { iconUrl: 'https://cdn.example.com/icon.png' } }))],
    ['a lone header icon', panel(withSecond({ ...SAFEWORDS, author: { iconUrl: UPLOAD } }))],
    ['an empty header', panel(withSecond({ ...SAFEWORDS, author: {} }))],
    ['nothing at all', panel({ embeds: [] })],
    ['6001 characters across the embeds', panel({ embeds: [{ description: 'x'.repeat(4096) }, { description: 'y'.repeat(1905) }] })],
    ['a bad picture beside an empty embed', panel({ embeds: [{ ...RULES, thumbnail: 'nope' }, {}] })],

    // --- tokens ---
    ['{{guild.name}} in the plain text', panel(withSecond(SAFEWORDS, 'You made it to {{guild.name}}.'))],
    ['{{subject.mention}} in embed 2’s footer', panel(withSecond({ ...SAFEWORDS, footer: { text: 'Mind yourself, {{subject.mention}}' } }))],
    ['a token in the header, the title, a field and the body', panel(withSecond({
        author: { name: '{{actor.displayName}}' },
        title: 'Hi {{subject.displayName}}',
        description: '{{ var.pick }}',
        fields: [{ name: 'Who', value: '{{subject.username}}' }],
    }))],
    ['a token thumbnail and a token image', panel(withSecond({ ...SAFEWORDS, thumbnail: '{{subject.avatarUrl}}', image: 'https://cdn/{{var.pic}}.png' }))],
    ['literal double braces', panel(withSecond({ ...SAFEWORDS, description: 'Type {{}} to summon nobody.' }))],
    ['a token in a button label', panel(withSecond(SAFEWORDS), [BUTTONS[0], { key: 'nope', label: 'Not you, {{subject.username}}', style: 'Danger' }] as Buttons)],
    ['two tokens, one after another, the same way', panel(withSecond({ ...SAFEWORDS, title: '{{a}}', description: '{{b}}' }, '{{c}}'))],

    // --- keys ---
    ['two buttons sharing a key', panel(withSecond(SAFEWORDS), [BUTTONS[0], { key: 'let-me-in', label: 'Me too', style: 'Primary' }] as Buttons)],
    [
        'every later stage at once',
        panel(
            { content: 'Hi {{subject.mention}}', embeds: [{}, { title: 'Ok', thumbnail: 'nah' }] },
            [{ key: 'same', label: '{{x}}', style: 'Primary' }, { key: 'same', label: 'Two', style: 'Danger' }]
        ),
    ],
    [
        'every later stage at once, with nothing to press and a bad emoji',
        panel(
            { content: 'Hi {{subject.mention}}', embeds: [{}] },
            [
                { key: 'same', label: '{{x}}', style: 'Primary', emoji: { name: 'nope' } },
                { key: 'same', style: 'Danger' },
            ]
        ),
    ],
];

/** What the server says, by stage: the schema's issues, or the resource rules' problems. */
function serverJudgement(declaration: BrowserResourceDeclaration): readonly { readonly where?: string; readonly path?: string; readonly message: string }[] {
    const parsed = ResourceDeclarationSchema.safeParse(declaration);
    if (!parsed.success) {
        return parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    }
    return messageResourceProblems(parsed.data).map((problem) => ({ ...(problem.where ? { where: problem.where } : {}), message: problem.message }));
}

/** What the browser says, shaped as the server's stage would be compared. */
function browserJudgement(declaration: BrowserResourceDeclaration, schemaStage: boolean) {
    return browserProblems(declaration).map((problem) =>
        schemaStage
            ? { path: problem.path, message: problem.message }
            : { ...(problem.where ? { where: problem.where } : {}), message: problem.message }
    );
}

describe('the browser judges a message resource as the server does', () => {
    it.each(TABLE)('%s', (_label, declaration) => {
        const server = serverJudgement(declaration);
        const schemaStage = !ResourceDeclarationSchema.safeParse(declaration).success;
        expect(browserJudgement(declaration, schemaStage)).toEqual(server);
    });

    it('covers both verdicts and every stage, so a vacuous table cannot pass', () => {
        const verdicts = TABLE.map(([, declaration]) => serverJudgement(declaration).length > 0);
        expect(verdicts).toContain(true);
        expect(verdicts).toContain(false);
        expect(TABLE.some(([, declaration]) => !ResourceDeclarationSchema.safeParse(declaration).success)).toBe(true);
    });
});
