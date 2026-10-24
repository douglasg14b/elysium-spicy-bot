import { MIB } from '../byteSizes';
import { MESSAGE_LIMITS } from './messageLimits';
import { messageUploadIds, messageUploadPlaces } from './messageParts';
import type { MessagePath } from './messageProblems';

/** One reason a message's uploaded pictures cannot go out with it, addressed to what to fix. */
export interface MessageUploadProblem {
    /** Relative to the message: the part showing a missing upload, or `[]` for the message as a whole. */
    readonly path: MessagePath;
    /** The part as the editor names it, numbered from one (`embed 1 image`); absent for the message as a whole. */
    readonly where?: string;
    readonly message: string;
}

/**
 * The upload rules, judged against what the message's server holds — **the one place** both
 * save-time readiness (`uploadReferenceIssues`) and Post Embed's run ask, so the two cannot
 * come to disagree about what one message may carry.
 *
 * Pure: the caller reads the sizes (`heldSizes`, upload id → bytes) of the uploads the message
 * names, **for the message's own server only**, and an id missing from it is not in that
 * server — deleted, or copied from another server's flow. In order:
 *
 *  - **Each upload a part shows is in the server**, addressed to that part, at each place it
 *    is shown.
 *  - **At most {@link MESSAGE_LIMITS.attachments} distinct uploads**, Discord's file limit
 *    for one message; an upload shown twice is attached once, so counted once.
 *  - **Their bytes together within {@link MESSAGE_LIMITS.uploadBytes}**, each counted once —
 *    of those the server holds, since a missing one carries nothing.
 *
 * Reads raw data, as `messageUploadPlaces` does, so it can be asked of a node as stored.
 */
export function messageUploadProblems(message: unknown, heldSizes: ReadonlyMap<string, number>): readonly MessageUploadProblem[] {
    const problems: MessageUploadProblem[] = [];

    for (const place of messageUploadPlaces(message)) {
        if (!heldSizes.has(place.uploadId)) {
            problems.push({
                path: place.path,
                where: place.where,
                message: "That uploaded picture isn't in this server. Pick another, or upload it again.",
            });
        }
    }

    const uploadIds = messageUploadIds(message);
    if (uploadIds.length > MESSAGE_LIMITS.attachments) {
        problems.push({
            path: [],
            message:
                `This message shows ${uploadIds.length} different uploaded pictures, and Discord takes ` +
                `${MESSAGE_LIMITS.attachments} files a message. Swap some for links, or show fewer.`,
        });
    }

    const bytes = uploadIds.reduce((total, uploadId) => total + (heldSizes.get(uploadId) ?? 0), 0);
    if (bytes > MESSAGE_LIMITS.uploadBytes) {
        problems.push({
            path: [],
            message:
                `The uploaded pictures in this message come to ${(bytes / MIB).toFixed(1)} MB, and Discord takes ` +
                `${MESSAGE_LIMITS.uploadBytes / MIB} MB a message. Use smaller pictures, or fewer of them.`,
        });
    }

    return problems;
}
