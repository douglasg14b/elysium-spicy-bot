import { describe, expect, it, vi } from 'vitest';

/**
 * The gateway connection is the one thing this route depends on, and the interesting
 * case is the cold-start window where it is absent — so the client is mocked rather
 * than the route exercised against a real login.
 */
let ready = false;
const botUser = { id: '123456789', username: 'BrattyBot Dev' };
vi.mock('../../../discordClient', () => ({
    DISCORD_CLIENT: {
        isReady: () => ready,
        get user() {
            return ready ? botUser : null;
        },
    },
}));

const { botRoutes, resolveFlavour } = await import('../botRoutes');

/**
 * Flavour is derived from the bot account's own name, so these cases are the contract
 * between what is set in the Discord Developer Portal and which logo the dashboard shows.
 */
describe('resolveFlavour', () => {
    it('treats the live bot name as production', () => {
        expect(resolveFlavour('BrattyBot')).toBe('production');
    });

    it('treats a Dev-suffixed name as development', () => {
        expect(resolveFlavour('BrattyBot Dev')).toBe('development');
    });

    it('treats the hyphenated dev name as development', () => {
        // The actual name on the dev application is `BrattyBot-Dev`, verified against
        // the live gateway. Separator-agnostic on purpose — a rename to a space or an
        // underscore in the Developer Portal must not silently flip it to production.
        expect(resolveFlavour('BrattyBot-Dev')).toBe('development');
        expect(resolveFlavour('BrattyBot_Dev')).toBe('development');
    });

    it('ignores case and surrounding whitespace on the suffix', () => {
        expect(resolveFlavour('BrattyBot DEV')).toBe('development');
        expect(resolveFlavour('  brattybot dev  ')).toBe('development');
    });

    it('accepts the spelled-out suffix', () => {
        expect(resolveFlavour('BrattyBot Development')).toBe('development');
    });

    it('does not match "dev" inside a longer trailing word', () => {
        // "Devious" ends the name but is not a dev marker — only a whole trailing
        // word counts, or the production bot could be mislabelled.
        expect(resolveFlavour('BrattyBot Devious')).toBe('production');
    });

    it('does not match "dev" away from the end of the name', () => {
        expect(resolveFlavour('Dev BrattyBot')).toBe('production');
    });
});

describe('GET /api/bot', () => {
    it('reports the connected bot account once the gateway is ready', async () => {
        ready = true;
        const res = await botRoutes().request('/');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            ready: true,
            id: '123456789',
            username: 'BrattyBot Dev',
            flavour: 'development',
        });
    });

    it('answers 200 with null fields before the gateway connects', async () => {
        // Not a 503: the web server binds its port before `login()` resolves, so this
        // is a normal cold start and the dashboard has bundled branding to fall back on.
        ready = false;
        const res = await botRoutes().request('/');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            ready: false,
            id: null,
            username: null,
            flavour: null,
        });
    });
});
