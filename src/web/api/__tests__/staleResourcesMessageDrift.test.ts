import { describe, expect, it } from 'vitest';
import { STALE_RESOURCES_MESSAGE as DASHBOARD_SENTENCE } from '../../../../web/src/flows/resourceSaveQueue';
import { STALE_RESOURCES_MESSAGE } from '../journeyBody';

/**
 * The resource autosave tells the stale-version 409 from the other 409s by its sentence
 * (`classifySaveFailure`), from a hand-written mirror, because nothing under `web/src` may
 * import the bot's tree. A mirror that drifted would read every stale save as an ordinary
 * refusal: the dashboard would revert the operator's typing to somebody else's list, then go
 * on sending saves that can only be refused.
 */
describe("the dashboard's stale-version sentence against the server's", () => {
    it('is the sentence both resource saves answer a stale version with', () => {
        expect(
            DASHBOARD_SENTENCE,
            'Reconcile `STALE_RESOURCES_MESSAGE` in `web/src/flows/resourceSaveQueue.ts` with `STALE_RESOURCES_MESSAGE` in `src/web/api/journeyBody.ts`.'
        ).toBe(STALE_RESOURCES_MESSAGE);
    });
});
