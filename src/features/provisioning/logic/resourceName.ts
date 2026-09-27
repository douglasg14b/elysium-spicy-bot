import type { ResourceKind } from './resourceDeclaration';

/**
 * The name Discord will actually store for a resource of this kind.
 *
 * ## Why this exists
 *
 * Discord rewrites a **text channel's** name on the way in: `Welcome Mat` is stored as
 * `welcome-mat`. Nothing on our side did the same, so a declaration saved as
 * `Welcome Mat` was installed as `welcome-mat` and then disagreed with it forever:
 *
 *  - drift compared the two exactly and reported a rename on a clean install;
 *  - repair sent `Welcome Mat` again, Discord stored `welcome-mat` again, and the drift
 *    never cleared;
 *  - install's reuse match lowercased but kept the space, so `staff chat` missed an
 *    existing `#staff-chat` and created a duplicate.
 *
 * Every one of those is "our idea of the name is not Discord's". Normalising at each
 * boundary where a name crosses into, or is compared against, Discord closes all of them
 * at once and leaves the stored declaration saying what the guild will say.
 *
 * ## What it does, and deliberately does not, model
 *
 * Only the two rewrites that are certain: **lowercase**, and **each whitespace character
 * becomes a hyphen**. Discord very likely strips some punctuation too, but the exact set
 * is not something this code can check, and modelling a guess would plant a new
 * permanent disagreement exactly where the old one was. A name with punctuation is sent
 * as written; if Discord rewrites it, drift reports it, which is loud rather than wrong.
 *
 * Per character rather than per run, and no trimming, so the result is identical to what
 * the resources panel produces keystroke by keystroke — a space typed becomes a hyphen
 * immediately, as it does in Discord's own client. A rule that collapsed runs or trimmed
 * would disagree with the panel on `a  b` and ` a`, and the panel would show a name the
 * server then silently changed.
 *
 * Categories and roles keep their case in Discord, so they pass through untouched.
 *
 * **Mirrored** in `web/src/flows/resourceName.ts`, which the browser uses as the operator
 * types. `resourceNameMirrorDrift.test.ts` runs both on the same inputs.
 */
export function normaliseResourceName(kind: ResourceKind, name: string): string {
    switch (kind) {
        case 'textChannel':
            return name.toLowerCase().replace(/\s/g, '-');
        case 'category':
        case 'role':
            return name;
        default: {
            const unreachable: never = kind;
            throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
        }
    }
}
