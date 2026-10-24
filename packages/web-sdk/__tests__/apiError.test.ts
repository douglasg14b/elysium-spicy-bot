import { describe, expect, it } from 'vitest';
import { apiErrorFromBody } from '../src/apiError';

/** What a refused delete carries through the SDK: the server's sentence and every place still showing the picture. */
describe('apiErrorFromBody', () => {
    const use = { flowId: 'flow-1', flowName: 'Welcome flow', nodeId: 'post', blockLabel: 'Post Embed', where: 'embed 1 image' };

    it("carries an in-use refusal's uses", () => {
        const refused = apiErrorFromBody(409, { error: 'Still on display.', uses: [use] });

        expect(refused.status).toBe(409);
        expect(refused.message).toBe('Still on display.');
        expect(refused.uses).toEqual([use]);
    });

    it('answers no uses for a refusal without them, or with something that is not a list', () => {
        expect(apiErrorFromBody(404, { error: 'Not here.' }).uses).toEqual([]);
        expect(apiErrorFromBody(409, { error: 'Odd.', uses: 'everywhere' }).uses).toEqual([]);
    });
});
