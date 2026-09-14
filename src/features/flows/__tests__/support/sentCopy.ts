import type { Mock } from 'vitest';

/**
 * What a flow block actually handed to discord.js when it sent copy.
 *
 * Blocks send `{ content, allowedMentions }` rather than a bare string, because
 * copy is a template now and a member's own display name reaches it — a member
 * called "@everyone" would otherwise make any flow saying `{{subject.username}}`
 * ping the guild. Tests that care about *what was said* should not have to
 * restate the mention allowlist at every assertion, and a test that did would
 * quietly stop checking anything the day the allowlist changed.
 *
 * `sentCopy` pulls out the text; the security property itself is asserted
 * directly, once, in `runVariables.test.ts`.
 */
export function sentCopy(send: Mock): string[] {
    return send.mock.calls.map(([payload]) => {
        // A bare string is rejected rather than tolerated. Accepting both shapes
        // would leave every caller passing identically against the pre-allowlist
        // code, so deleting `allowedMentions` from a block would keep the suite
        // green — the helper would have quietly stopped testing the thing it was
        // introduced for.
        if (typeof payload !== 'object' || payload === null) {
            throw new Error(
                `A flow block sent ${JSON.stringify(payload)} rather than a payload object. Copy must be sent ` +
                    'as `{ content, allowedMentions }` so a member\'s own name cannot ping the guild.'
            );
        }

        const { content } = payload as { content?: unknown };
        if (typeof content !== 'string') {
            throw new Error(`A flow block sent a payload with no string content: ${JSON.stringify(payload)}`);
        }

        return content;
    });
}
