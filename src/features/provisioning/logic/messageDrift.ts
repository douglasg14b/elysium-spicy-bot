import { createHash } from 'node:crypto';
import { z } from 'zod';
import { messageShape, type DiscordMessageInput } from '../../../shared/discordMessage';
import type { MessageButton } from './messageButtons';

/**
 * Whether a posted message is still what its journey declares — by fingerprint.
 *
 * Only a message's author can edit it, so nobody but the bot can change what is posted: its
 * content drifts only when its declaration moves on. (The one thing anyone else can do is hide
 * its embeds, which the drift check reads from Discord instead — `readMessageState`.) A
 * fingerprint stored when it is posted
 * (and after each repair) is therefore exact, where comparing against what Discord holds
 * would only add Discord's own rewriting — `attachment://` comes back as a CDN link, and
 * colours and links are normalised (`docs/plans/message-resource-step-2.md`, correction 5).
 */

/**
 * The message as the fingerprint reads it: its defaults filled in, so `fields: []` and no
 * `fields` hash the same, and nothing the shape does not know kept. Pictures are plain
 * strings here — whether one is a picture Discord takes is the save's question, not this.
 */
const digestShape = messageShape({ picture: z.string(), fillDefaults: true });

/**
 * JSON with every object's keys in sorted order, at every depth; arrays keep their order.
 *
 * The defence against key order from any source. Postgres's `jsonb` stores an object's keys
 * in an order of its own, so `JSON.stringify` of a declaration read back from it would
 * fingerprint every message differently from the one it was posted from — out of date on
 * Postgres, and never on SQLite. Values are whatever JSON holds; `undefined` members are
 * left out, as `JSON.stringify` leaves them.
 */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, member]) => member !== undefined)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * The fingerprint of a message resource's declaration: a SHA-256, in hex, of the
 * {@link canonicalJson} of `{ message, buttons }`, with the message's defaults filled first.
 * No buttons and an empty list are the same. A button's absent label or emoji is left out, so
 * a message whose buttons carry no emoji fingerprints as it did before buttons could carry one; a
 * changed emoji makes the post out of date, like a changed label. A server emoji deleted
 * since is not: the declaration did not move.
 *
 * Stored on the binding when the message is posted (`upsertPostedMessage`) and after each
 * repair (`recordMessageDigest`).
 *
 * @throws when the message is not a message at all — something a saved declaration never
 * holds, since the save checks it against this same shape.
 */
export function messageDigest(message: DiscordMessageInput, buttons: readonly MessageButton[] = []): string {
    const filled = digestShape.parse(message);
    const buttonParts = buttons.map(({ key, label, style, emoji }) => ({ key, label, style, emoji }));
    return createHash('sha256').update(canonicalJson({ message: filled, buttons: buttonParts })).digest('hex');
}
