import type { ResourceKind } from '../api/types';

/**
 * The name Discord will actually store for a resource of this kind.
 *
 * A mirror of `normaliseResourceName` in
 * `src/features/provisioning/logic/resourceName.ts`, which explains the rule and why it
 * stops where it does. The browser cannot import that module, and it needs the rule as
 * the operator types — so the Name field shows `welcome-mat` while `Welcome Mat` is
 * being typed, the way Discord's own client does, rather than the server quietly saving
 * something other than what the panel displayed.
 *
 * `resourceNameMirrorDrift.test.ts` runs both on the same inputs, so the two cannot
 * disagree without a named test failing.
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
