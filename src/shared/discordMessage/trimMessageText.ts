import type { DiscordEmbed, DiscordMessage } from './messageConfigSchema';

/**
 * A rendered message with its text parts trimmed, and each part that is blank once trimmed
 * left out — the plain text, and each embed's title, body, header text and footer text.
 *
 * For after the tokens are filled in: `{{var.note}}` holding nothing, or a single space,
 * leaves a part Discord refuses with a 400 naming `embeds.0.title` and nothing an author can
 * act on. Left out instead, the message goes on to `messageProblems`, which says in the
 * product's words what that leaves — an empty embed, a footer icon with no text beside it,
 * or nothing to post at all. And the message sent is this one, so a part that is only
 * whitespace is never sent as if it were text.
 *
 * Field headings and text are kept as they are: a field cannot be left out by halves, and
 * the caller refuses a blank side by name before asking anything else.
 */
export function trimMessageText(message: DiscordMessage): DiscordMessage {
    const content = message.content?.trim();
    const { content: _content, ...rest } = message;
    return {
        ...rest,
        ...(content ? { content } : {}),
        embeds: message.embeds.map(trimEmbedText),
    };
}

/** One embed with {@link trimMessageText}'s rule applied to its title, body, header and footer text. */
function trimEmbedText(embed: DiscordEmbed): DiscordEmbed {
    const { title, description, author, footer, ...rest } = embed;
    const trimmedTitle = title?.trim();
    const trimmedDescription = description?.trim();
    const authorName = author?.name?.trim();
    const footerText = footer?.text?.trim();

    return {
        ...rest,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
        ...(author
            ? { author: { ...(authorName ? { name: authorName } : {}), ...(author.iconUrl ? { iconUrl: author.iconUrl } : {}) } }
            : {}),
        ...(footer
            ? { footer: { ...(footerText ? { text: footerText } : {}), ...(footer.iconUrl ? { iconUrl: footer.iconUrl } : {}) } }
            : {}),
    };
}
