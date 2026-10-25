import { describe, expect, it } from 'vitest';
import type { DiscordMessageInput } from '../../../../shared/discordMessage';
import type { MessageButton } from '../messageButtons';
import { describeMessageResourceProblem, messageResourceProblems } from '../messageResourceProblems';
import type { ResourceDeclaration } from '../resourceDeclaration';

/**
 * What a message resource is refused for on save, each problem naming its part.
 *
 * The token rows are the reason this module exists beside `messageConfigSchema`: a token
 * passes every rule a Post Embed node is saved under — that is what a run fills in — so only
 * the no-tokens rule refuses them. Each token fixture is otherwise clean, so the row fails
 * only if that rule is gone.
 */

type Embed = DiscordMessageInput['embeds'][number];

const FIRST_EMBED: Embed = { title: 'House rules', description: 'Be filthy, be kind.', footer: { text: 'The management' } };
const SECOND_EMBED: Embed = { title: 'Safewords', footer: { text: 'Red means stop' } };

const CLEAN: DiscordMessageInput = {
    content: 'Read these before you touch anything.',
    embeds: [FIRST_EMBED, SECOND_EMBED],
};

const LET_ME_IN: MessageButton = { key: 'let-me-in', label: 'Let me in', style: 'Success' };
const BUTTONS: readonly MessageButton[] = [LET_ME_IN, { key: 'nope', label: 'Nope', style: 'Danger' }];

function panel(message: DiscordMessageInput, buttons: readonly MessageButton[] = BUTTONS): ResourceDeclaration {
    return { key: 'rules-panel', kind: 'message', defaultName: 'Rules panel', parentKey: 'rules', message, buttons };
}

/** The first problem, as the save route words it. */
function refusal(declaration: ResourceDeclaration): string | undefined {
    const [problem] = messageResourceProblems(declaration);
    return problem && describeMessageResourceProblem(declaration.defaultName, problem);
}

/** {@link CLEAN} with its second embed replaced. */
const secondEmbed = (embed: Embed): DiscordMessageInput => ({ ...CLEAN, embeds: [FIRST_EMBED, embed] });

describe('messageResourceProblems', () => {
    it('passes a clean message with buttons', () => {
        expect(messageResourceProblems(panel(CLEAN))).toEqual([]);
    });

    it.each([
        [
            '{{subject.mention}} in embed 2’s footer',
            panel(secondEmbed({ ...SECOND_EMBED, footer: { text: 'Mind yourself, {{subject.mention}}' } })),
            /^"Rules panel" embed 2 footer: No tokens here/,
        ],
        [
            '{{guild.name}} in the plain text',
            panel({ ...CLEAN, content: 'You made it to {{guild.name}}.' }),
            /^"Rules panel" plain text: No tokens here/,
        ],
        [
            'a token picture',
            panel(secondEmbed({ ...SECOND_EMBED, thumbnail: '{{subject.avatarUrl}}' })),
            /^"Rules panel" embed 2 thumbnail: No tokens here.*Pick an upload or paste a link\.$/,
        ],
        [
            'a token in a button label',
            panel(CLEAN, [LET_ME_IN, { key: 'nope', label: 'Not you, {{subject.username}}', style: 'Danger' }]),
            /^"Rules panel" button 2: No tokens here/,
        ],
    ])('refuses %s, naming the part', (_label, declaration, sentence) => {
        expect(refusal(declaration)).toMatch(sentence);
    });

    it.each([
        ['an empty embed', panel(secondEmbed({})), /^"Rules panel" embed 2: Embed 2 is empty/],
        [
            'a lone footer icon',
            panel(secondEmbed({ title: 'Safewords', footer: { iconUrl: 'https://cdn.example.com/icon.png' } })),
            /^"Rules panel" embed 2: Embed 2's footer needs some text/,
        ],
        [
            '6001 characters across the embeds',
            panel({
                embeds: [
                    { title: 'Part one', description: 'x'.repeat(4096 - 8) },
                    { description: 'y'.repeat(6001 - 4096) },
                ],
            }),
            /^"Rules panel": This message's embeds hold 6001 characters/,
        ],
        [
            'two buttons sharing a key',
            panel(CLEAN, [LET_ME_IN, { key: 'let-me-in', label: 'Me too', style: 'Primary' }]),
            /^"Rules panel" button 2: Another button on this message already has the key "let-me-in"/,
        ],
        [
            'a part over its own limit',
            panel(secondEmbed({ ...SECOND_EMBED, title: 't'.repeat(257) })),
            /^"Rules panel" embed 2 title: Titles stop at 256 characters\.$/,
        ],
    ])('refuses %s', (_label, declaration, sentence) => {
        expect(refusal(declaration)).toMatch(sentence);
    });

    it('leaves a declaration with no message to the structural check', () => {
        expect(messageResourceProblems({ key: 'rules-panel', kind: 'message', defaultName: 'Rules panel' })).toEqual([]);
    });
});
