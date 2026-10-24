/**
 * Each part's own rule, read off the SDK's `zDiscordMessage` — the same schema, with the
 * same sentences, the server builds the block's message from (`messageShape`).
 *
 * Nothing here restates a limit: the counter under a title reads its 256 from the zod, and
 * the problem it shows is the zod's own sentence. The rules spanning parts (an empty embed,
 * an icon with no text beside it) are the server's alone; it is re-asked as focus leaves a
 * part, and its answer marks the part it names.
 */

import { zDiscordMessage } from '@brattybot/web-sdk';
import type { TextPart } from './messageDraft';

const embedRules = zDiscordMessage.shape.embeds.element.shape;
const fieldRules = embedRules.fields.unwrap().element.shape;

/** One text part's rule: its longest length, when it has one, and what is wrong with a value. */
export interface PartRule {
    readonly maxLength: number | null;
    /** The schema's own sentence about `text`, or `undefined` when the part takes it. */
    readonly problem: (text: string) => string | undefined;
}

type StringRule = typeof fieldRules.name;

function ruleOf(schema: StringRule): PartRule {
    return {
        maxLength: schema.maxLength,
        problem: (text) => {
            const parsed = schema.safeParse(text);
            return parsed.success ? undefined : parsed.error.issues[0]?.message;
        },
    };
}

const RULES = {
    content: ruleOf(zDiscordMessage.shape.content.unwrap()),
    authorName: ruleOf(embedRules.author.unwrap().shape.name.unwrap()),
    title: ruleOf(embedRules.title.unwrap()),
    url: ruleOf(embedRules.url.unwrap()),
    description: ruleOf(embedRules.description.unwrap()),
    footerText: ruleOf(embedRules.footer.unwrap().shape.text.unwrap()),
    fieldName: ruleOf(fieldRules.name),
    fieldValue: ruleOf(fieldRules.value),
} as const satisfies Record<TextPart['kind'], PartRule>;

/** The rule a text part is judged by. */
export function partRule(part: TextPart): PartRule {
    return RULES[part.kind];
}

/**
 * An array rule's maximum, failing as the module loads when the contract declares none — a
 * window that offered "Add" forever would let an author build a message the save refuses.
 * Read from zod's check bag, which zod types loosely, so the number is checked rather than
 * trusted.
 */
function maximumOf(maximum: unknown, rule: string): number {
    if (typeof maximum !== 'number') {
        throw new Error(`The generated contract declares no maximum for ${rule}, so the editor cannot tell when to stop adding.`);
    }
    return maximum;
}

/** The most embeds one message holds. */
export const MAX_EMBEDS = maximumOf(zDiscordMessage.shape.embeds._zod.bag.maximum, 'DiscordMessage.embeds');

/** The most fields one embed holds. */
export const MAX_FIELDS = maximumOf(embedRules.fields.unwrap()._zod.bag.maximum, 'DiscordMessage.embeds[].fields');
