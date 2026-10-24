import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uploadImageUrl } from '../../../../web/src/api/uploadImageUrl';
import { OPENAPI_SPEC_PATH } from '../openApiDocument';

/**
 * The dashboard's picture address against the route that serves it.
 *
 * `uploadImageUrl` builds the address by hand, because an `<img src>` cannot go through the
 * SDK (it reads every answer as JSON). A route moved without it would leave every picture in
 * the message editor broken, with nothing failing to compile — so the address is held here to
 * the committed spec's `getGuildUpload` path, found by its operation id.
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

describe('the address an uploaded picture is shown from', () => {
    it("is the spec's getGuildUpload path", () => {
        const guildId = '123456789012345678';
        const uploadId = '7d4f3b52-9a51-4a7b-8f53-0f6c5b0d2c11';
        const fromSpec = pathOf('getGuildUpload').replace('{guildId}', guildId).replace('{uploadId}', uploadId);

        expect(
            uploadImageUrl({ guildId, uploadId }),
            'Reconcile `web/src/api/uploadImageUrl.ts` with the `getGuildUpload` route in `src/web/api/uploadRoutes.ts`.'
        ).toBe(fromSpec);
    });
});
