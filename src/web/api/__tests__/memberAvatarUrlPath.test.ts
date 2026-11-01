import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memberAvatarUrl } from '../memberNameBody';
import { OPENAPI_SPEC_PATH } from '../openApiDocument';

/**
 * A member's `avatarUrl` against the route that serves it.
 *
 * The server builds the address by hand (`memberAvatarUrl`) and the dashboard puts it in an
 * `<img src>` as it comes, since a picture cannot go through the SDK. A route moved without
 * it would leave every kept avatar broken, with nothing failing to compile — so the address
 * is held here to the committed spec's `getMemberAvatar` path, found by its operation id, as
 * `uploadImageUrlPath.test.ts` holds the upload's.
 */

interface SpecOperation {
    readonly operationId?: string;
}

function pathOf(operationId: string): string {
    const spec = JSON.parse(readFileSync(resolve(process.cwd(), OPENAPI_SPEC_PATH), 'utf8')) as {
        paths: Record<string, Record<string, SpecOperation>>;
    };
    const found = Object.entries(spec.paths).find(([, operations]) =>
        Object.values(operations).some((operation) => operation.operationId === operationId)
    );
    if (!found) throw new Error(`The spec has no operation ${operationId}.`);
    return found[0];
}

describe('the address a kept avatar is shown from', () => {
    it("is the spec's getMemberAvatar path, versioned by the picture's hash", () => {
        const guildId = '123456789012345678';
        const userId = '400000000000000001';
        const fromSpec = pathOf('getMemberAvatar').replace('{guildId}', guildId).replace('{userId}', userId);

        expect(
            memberAvatarUrl(guildId, userId, 'a_1f2e3d'),
            'Reconcile `memberAvatarUrl` in `src/web/api/memberNameBody.ts` with the `getMemberAvatar` route.'
        ).toBe(`${fromSpec}?v=a_1f2e3d`);
    });
});
