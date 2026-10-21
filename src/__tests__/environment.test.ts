import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_SESSION_SECRET, MIN_SESSION_SECRET_LENGTH, sessionSecretProblem } from '../environment';

/**
 * The session secret is the dashboard's whole security boundary — whoever knows it can
 * mint a session as anyone — so one that is missing, short or published keeps the
 * dashboard off rather than signing with it.
 */

const STRONG_SECRET = 'q7Vb2xR9mK4pL8sT1wY6zN3cF5hJ0dGa';

describe('sessionSecretProblem', () => {
    it('accepts a secret of at least the minimum length', () => {
        expect(STRONG_SECRET).toHaveLength(MIN_SESSION_SECRET_LENGTH);
        expect(sessionSecretProblem(STRONG_SECRET, false)).toBeUndefined();
    });

    it('names a missing secret', () => {
        expect(sessionSecretProblem(undefined, false)).toBe('SESSION_SECRET (any long random string)');
    });

    it('refuses a secret one character too short', () => {
        expect(sessionSecretProblem(STRONG_SECRET.slice(1), false)).toBe(
            'SESSION_SECRET (must be at least 32 random characters)'
        );
    });

    it('refuses a short secret in development too', () => {
        expect(sessionSecretProblem('hunter2', true)).toBe('SESSION_SECRET (must be at least 32 random characters)');
    });

    it('accepts the development placeholder in development', () => {
        expect(sessionSecretProblem(DEV_SESSION_SECRET, true)).toBeUndefined();
    });

    it('refuses the development placeholder anywhere else, though it is long enough', () => {
        expect(DEV_SESSION_SECRET.length).toBeGreaterThanOrEqual(MIN_SESSION_SECRET_LENGTH);
        expect(sessionSecretProblem(DEV_SESSION_SECRET, false)).toMatch(/^SESSION_SECRET \(the development placeholder is refused/);
    });
});

/** `environment.ts` as loaded with `secret`, outside development and with the rest of the web config set. */
async function loadEnvironmentWith(secret: string): Promise<typeof import('../environment')> {
    vi.stubEnv('ENV', '');
    vi.stubEnv('WEB_PUBLIC_URL', 'https://dashboard.test');
    vi.stubEnv('DISCORD_OAUTH_CLIENT_SECRET', 'vitest-oauth-client-secret');
    vi.stubEnv('SESSION_SECRET', secret);
    vi.resetModules();
    return import('../environment');
}

describe('the session secret environment.ts hands out', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('is none, and the dashboard stays off naming why, when the configured one is too short', async () => {
        const environment = await loadEnvironmentWith('too-short-to-sign-anything');

        expect(environment.SESSION_SECRET).toBeUndefined();
        expect(environment.WEB_ENABLED).toBe(false);
        expect(environment.getMissingWebEnv()).toEqual(['SESSION_SECRET (must be at least 32 random characters)']);
    });

    it('is the configured one when it is strong', async () => {
        const environment = await loadEnvironmentWith(STRONG_SECRET);

        expect(environment.SESSION_SECRET).toBe(STRONG_SECRET);
        expect(environment.WEB_ENABLED).toBe(true);
        expect(environment.getMissingWebEnv()).toEqual([]);
    });
});
