import { describe, expect, it } from 'vitest';
import { messageConfigSchema, type DiscordEmbed, type DiscordMessage } from '../messageConfigSchema';
import { messageProblems } from '../messageProblems';

/** Problems as `path: message`, for one readable assertion per case. */
function problemsOf(message: DiscordMessage): string[] {
    return messageProblems(message).map((problem) => `${problem.path.join('.')}: ${problem.message}`);
}

/** An embed as parsed, its defaults filled. */
const embed = (parts: Partial<DiscordEmbed>): DiscordEmbed => ({ fields: [], timestamp: false, ...parts });

const ICON = 'https://cdn.example/icon.png';

describe('the rules spanning parts', () => {
    it('passes a message with plain text alone, or one embed with something in it', () => {
        expect(problemsOf({ content: 'Hi', embeds: [] })).toEqual([]);
        expect(problemsOf({ embeds: [embed({ image: 'https://cdn.example/a.png' })] })).toEqual([]);
        expect(problemsOf({ embeds: [embed({ footer: { text: 'Small print' } })] })).toEqual([]);
    });

    it('refuses a message with nothing in it, addressed to the message as a whole', () => {
        expect(problemsOf({ embeds: [] })).toEqual([
            ": This message is empty. Give it some plain text or an embed — Discord won't post nothing.",
        ]);
    });

    it('refuses an empty embed, numbered from one', () => {
        expect(problemsOf({ embeds: [embed({ title: 'One' }), embed({ color: '#00A2FF' })] })).toEqual([
            'embeds.1: Embed 2 is empty — give it a title, some words, a field or a picture, or bin it.',
        ]);
    });

    it('refuses a header or footer icon with no text beside it', () => {
        expect(problemsOf({ embeds: [embed({ title: 'T', author: { iconUrl: ICON } })] })).toEqual([
            "embeds.0.author: Embed 1's header needs some text — Discord drops a header icon with nothing beside it.",
        ]);
        expect(problemsOf({ embeds: [embed({ title: 'T', footer: { iconUrl: ICON } })] })).toEqual([
            "embeds.0.footer: Embed 1's footer needs some text — Discord drops a footer icon with nothing beside it.",
        ]);
    });

    it('refuses a header or footer with neither text nor an icon, without talking about an icon', () => {
        expect(problemsOf({ embeds: [embed({ title: 'T', author: {}, footer: {} })] })).toEqual([
            "embeds.0.author: Embed 1's header is empty — give it some text or take it off.",
            "embeds.0.footer: Embed 1's footer is empty — give it some text or take it off.",
        ]);
    });

    it("refuses embeds whose text together is over Discord's 6000, addressed to the message", () => {
        // Each part within its own limit; the two bodies together are 6002 with the titles.
        const over = { embeds: [embed({ title: 'T', description: 'd'.repeat(4000) }), embed({ title: 'U', description: 'd'.repeat(2000) })] };
        const atLimit = { embeds: [embed({ title: 'T', description: 'd'.repeat(3999) }), embed({ title: 'U', description: 'd'.repeat(1999) })] };

        expect(problemsOf(atLimit)).toEqual([]);
        expect(problemsOf(over)).toEqual([
            ": This message's embeds hold 6002 characters of text, and Discord's limit across all of them is 6000. " +
                "Trim a body or drop a field — each part fits on its own, it's the total that is over.",
        ]);
    });

    it('counts only the text outside tokens, so a message that could still post is never refused', () => {
        // 6000 written characters, and two tokens that may come out as anything — even nothing.
        const written = (body: number) => ({
            embeds: [
                embed({ title: '{{subject.username}}', description: `${'d'.repeat(body)}{{var.signoff}}` }),
                embed({ title: 'U', description: 'd'.repeat(2000) }),
            ],
        });
        const withTokens = written(3999);
        const writtenOver = written(4000);

        expect(problemsOf(withTokens)).toEqual([]);
        expect(problemsOf(writtenOver)).toEqual([expect.stringContaining('hold 6001 characters of text')]);
    });

    it('reads a message whose defaults are not filled in, as the wire sends it', () => {
        expect(messageProblems({ embeds: [{ title: 'T' }] })).toEqual([]);
        expect(messageProblems({ embeds: [{ color: '#00A2FF' }] }).map((problem) => problem.path)).toEqual([['embeds', 0]]);
    });
});

describe('through the block-side schema', () => {
    it('lands each problem at its own path under the message', () => {
        const parsed = messageConfigSchema.safeParse({
            embeds: [{ title: 'Fine' }, {}, { title: 'T', footer: { iconUrl: ICON } }],
        });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['embeds.1', 'embeds.2.footer']);
    });
});
