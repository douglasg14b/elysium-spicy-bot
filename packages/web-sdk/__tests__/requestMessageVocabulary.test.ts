import { describe, expect, it } from 'vitest';
import {
    REQUEST_MESSAGE_KEYWORDS as SERVER_KEYWORDS,
    REQUEST_MESSAGES_EXTENSION as SERVER_EXTENSION,
} from '../../../src/web/api/requestMessages';
import {
    REQUEST_MESSAGE_KEYWORDS as SDK_KEYWORDS,
    REQUEST_MESSAGES_EXTENSION as SDK_EXTENSION,
} from '../zodMessageResolvers';

/**
 * The emit side (`src/web/api/requestMessages.ts`) and the SDK side
 * (`zodMessageResolvers.ts`) each keep the extension name and keyword list, because the
 * SDK does not compile the bot. This holds the two copies to each other.
 */
describe('request message vocabulary', () => {
    it('is the same on the server and in the SDK', () => {
        expect(SDK_EXTENSION).toBe(SERVER_EXTENSION);
        expect([...SDK_KEYWORDS].sort()).toEqual([...SERVER_KEYWORDS].sort());
    });
});
