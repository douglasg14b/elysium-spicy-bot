import { describe, expect, it } from 'vitest';
import { ResourceDeclarationSchema } from '../../../../web/api/journeyBody';
import { messageButtonsConfigSchema } from '../messageButtonSchema';
import { messageResourceProblems } from '../messageResourceProblems';

/**
 * One button rule set, asked two ways: a journey message's buttons (the route's schema, then
 * `messageResourceProblems`) and a block's (`messageButtonsConfigSchema`, Post Embed's and
 * Open Ticket's `buttons`). The same buttons must be refused for the same reasons, in the same
 * order, with the same sentences, on the same button — whichever kind of message they sit
 * under. The block's schema is a second copy of the wire's, written in plain zod, so this is
 * what holds the two together.
 */

const SERVER_EMOJI_ID = '112233445566778899';
const LET_ME_IN = { key: 'let-me-in', label: 'Let me in', style: 'Success' };
const NOPE = { key: 'nope', label: 'Nope', style: 'Danger' };

const TABLE: readonly (readonly [string, readonly Record<string, unknown>[]])[] = [
    ['two clean buttons', [LET_ME_IN, NOPE]],
    ['an emoji-only button, and a server emoji beside a label', [
        { key: 'spicy', style: 'Danger', emoji: { name: '🌶️' } },
        { key: 'love', label: 'Love', style: 'Primary', emoji: { id: SERVER_EMOJI_ID, name: 'blob_heart', animated: true } },
    ]],

    // --- each button's own fields ---
    ['a key with an underscore', [{ key: 'let_me_in', label: 'Let me in', style: 'Success' }]],
    ['no key at all', [{ key: '', label: 'Let me in', style: 'Success' }]],
    ['a blank label', [{ key: 'blank', label: '', style: 'Secondary' }]],
    ['a label of 81', [{ key: 'long', label: 'x'.repeat(81), style: 'Primary' }]],
    ['a server emoji id that is not one', [{ key: 'love', style: 'Primary', emoji: { id: '12', name: 'blobheart' } }]],
    ['an emoji name of 33', [{ key: 'love', style: 'Primary', emoji: { name: 'x'.repeat(33) } }]],
    ['a nameless emoji', [{ key: 'love', label: 'Love', style: 'Primary', emoji: { name: '' } }]],
    ['26 buttons', Array.from({ length: 26 }, (_unused, index) => ({ key: `b${index}`, label: `B${index}`, style: 'Primary' }))],

    // --- the rules spanning a button, or the list ---
    ['a button with neither a label nor an emoji', [LET_ME_IN, { key: 'blank', style: 'Secondary' }]],
    ['a word where a standard emoji goes', [{ key: 'fire', label: 'Fire', style: 'Danger', emoji: { name: 'fire' } }]],
    ['a server emoji named with a hyphen', [{ key: 'love', style: 'Primary', emoji: { id: SERVER_EMOJI_ID, name: 'blob-heart' } }]],
    ['an animated standard emoji', [{ key: 'spicy', style: 'Danger', emoji: { name: '🌶️', animated: true } }]],
    ['a token in a label', [LET_ME_IN, { key: 'nope', label: 'Not you, {{subject.username}}', style: 'Danger' }]],
    ['literal braces in a label', [{ key: 'braces', label: 'Type {{}}', style: 'Primary' }]],
    ['two buttons sharing a key', [LET_ME_IN, { key: 'let-me-in', label: 'Me too', style: 'Primary' }]],
    ['every spanning rule at once', [
        { key: 'same', label: '{{x}}', style: 'Primary', emoji: { name: 'nope' } },
        { key: 'same', style: 'Danger' },
    ]],
];

/** What one refusal says, and which button it is on (`undefined` for the list as a whole). */
interface Refusal {
    readonly button: number | undefined;
    readonly message: string;
}

/** A clean message, so every refusal is about the buttons. */
const MESSAGE = { embeds: [{ title: 'House rules', description: 'Be filthy, be kind.' }] };

/** The journey's judgement: the route's schema, and its resource rules once that passes. */
function journeyRefusals(buttons: readonly Record<string, unknown>[]): readonly Refusal[] {
    const parsed = ResourceDeclarationSchema.safeParse({
        key: 'rules-panel',
        kind: 'message',
        defaultName: 'Rules panel',
        parentKey: 'rules',
        message: MESSAGE,
        buttons,
    });
    if (!parsed.success) {
        return parsed.error.issues.map((issue) => {
            const [, index] = issue.path;
            return { button: typeof index === 'number' ? index : undefined, message: issue.message };
        });
    }
    return messageResourceProblems(parsed.data).map((problem) => {
        const match = /^button (\d+)$/.exec(problem.where ?? '');
        return { button: match ? Number(match[1]) - 1 : undefined, message: problem.message };
    });
}

/** A block's judgement of the same buttons. */
function blockRefusals(buttons: readonly Record<string, unknown>[]): readonly Refusal[] {
    const parsed = messageButtonsConfigSchema.safeParse(buttons);
    if (parsed.success) return [];
    return parsed.error.issues.map((issue) => {
        const [index] = issue.path;
        return { button: typeof index === 'number' ? index : undefined, message: issue.message };
    });
}

describe("a block's buttons are refused as a journey message's are", () => {
    it.each(TABLE)('%s', (_label, buttons) => {
        expect(blockRefusals(buttons)).toEqual(journeyRefusals(buttons));
    });

    it('covers both verdicts and both stages, so a vacuous table cannot pass', () => {
        const refused = TABLE.filter(([, buttons]) => journeyRefusals(buttons).length > 0);
        expect(refused.length).toBeGreaterThan(0);
        expect(refused.length).toBeLessThan(TABLE.length);

        // Some rows fail a button's own fields (the schema), and some only the rules spanning them.
        const schemaStage = (buttons: readonly Record<string, unknown>[]) => !messageButtonsConfigSchema.safeParse(buttons).success;
        expect(TABLE.some(([, buttons]) => schemaStage(buttons))).toBe(true);
        expect(refused.some(([, buttons]) => messageResourceProblems({
            key: 'rules-panel', kind: 'message', defaultName: 'Rules panel', message: MESSAGE,
            buttons: buttons as never,
        }).length > 0)).toBe(true);
    });
});
