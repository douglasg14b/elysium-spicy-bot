import type { ResourceDeclaration } from '@brattybot/web-sdk';

/**
 * The keys of installed messages whose declaration a save just changed — the ones the server
 * still shows as they were posted.
 *
 * "Reinstall missing pieces" rebuilds only what is gone, so an edit to a posted message is
 * neither missing nor something install notices: the drift check (`JourneyDriftDialog`) is
 * what compares the post to its declaration and edits it. This is how the builder knows to
 * point there, from the two saved lists alone and without asking Discord.
 *
 * Only what the post is made of counts — the message and its buttons. A rename or a move
 * changes neither, and a message not yet installed is install's to post, not drift's. A
 * message with no earlier version is new, so there is nothing posted to differ from.
 */
export function editedInstalledMessageKeys(input: {
    readonly before: readonly ResourceDeclaration[];
    readonly after: readonly ResourceDeclaration[];
    readonly installedKeys: ReadonlySet<string>;
}): string[] {
    const { before, after, installedKeys } = input;
    const earlier = new Map(before.map((resource) => [resource.key, resource] as const));

    return after
        .filter((resource) => {
            if (resource.kind !== 'message' || !installedKeys.has(resource.key)) return false;
            const previous = earlier.get(resource.key);
            return previous !== undefined && postedPart(previous) !== postedPart(resource);
        })
        .map((resource) => resource.key);
}

function postedPart({ message, buttons }: ResourceDeclaration): string {
    return JSON.stringify({ message, buttons: buttons ?? [] });
}
