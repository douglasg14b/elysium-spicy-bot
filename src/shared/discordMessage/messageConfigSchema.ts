import type { z } from 'zod';
import { messageProblems } from './messageProblems';
import { messageShape } from './messageShape';
import { HTTP_LINK_PATTERN, isUsableLink, pictureRefSchema } from './pictureRef';

/**
 * A message as a block's config holds it: {@link messageShape} with refined pictures, and the
 * rules spanning parts from `messageProblems`, each at its own path.
 *
 * One server-only rule besides: a **title link must parse as a URL**. The shape checks it by
 * pattern alone, because the pattern is what the browser can be given, but `https://a%zz/x`
 * fits the pattern and makes discord.js's `setURL` throw on every run. Reported only for a
 * link that fits the pattern, so a link that does not gets the shape's sentence alone.
 *
 * The refinement stays out of the JSON Schema export, so a block field over this exports as a
 * plain `object` the browser leaves to the server, and the cross-part sentences arrive with
 * the server's re-check.
 */
export const messageConfigSchema = messageShape({ picture: pictureRefSchema, fillDefaults: true }).superRefine(
    (message, context) => {
        for (const problem of messageProblems(message)) {
            context.addIssue({ code: 'custom', path: [...problem.path], message: problem.message });
        }
        for (const [index, embed] of message.embeds.entries()) {
            if (embed.url && HTTP_LINK_PATTERN.test(embed.url) && !isUsableLink(embed.url)) {
                context.addIssue({
                    code: 'custom',
                    path: ['embeds', index, 'url'],
                    message: "That title link doesn't read as a real address — check it for a stray % or an odd character.",
                });
            }
        }
    }
);

/** A message, parsed, its defaults filled: what a block receives. */
export type DiscordMessage = z.output<typeof messageConfigSchema>;

/**
 * A message as stored and as a `message` field's default declares it — schema input, so
 * `fields`, `inline` and `timestamp` may be absent. The same type as the wire's
 * `DiscordMessage`, and as the one the SDK generates from it.
 */
export type DiscordMessageInput = z.input<typeof messageConfigSchema>;

/** One embed of a {@link DiscordMessage}. */
export type DiscordEmbed = DiscordMessage['embeds'][number];
