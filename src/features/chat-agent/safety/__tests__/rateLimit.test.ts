import { describe, expect, it } from 'vitest';
import { ChatRateLimiter } from '../rateLimit';

const SETTINGS = { maxTurns: 2, windowMs: 60_000, cooldownMs: 300_000 };

describe('ChatRateLimiter', () => {
    it('allows turns up to the limit, warns once on the next, then ignores until the cooldown ends', () => {
        const limiter = new ChatRateLimiter(SETTINGS);
        expect(limiter.attempt('guild', 'vex', 0)).toBe('allow');
        expect(limiter.attempt('guild', 'vex', 1_000)).toBe('allow');
        expect(limiter.attempt('guild', 'vex', 2_000)).toBe('warn');
        expect(limiter.attempt('guild', 'vex', 3_000)).toBe('ignore');
        expect(limiter.attempt('guild', 'vex', 2_000 + 300_000 - 1)).toBe('ignore');
        expect(limiter.attempt('guild', 'vex', 2_000 + 300_000)).toBe('allow');
    });

    it('forgets turns older than the window', () => {
        const limiter = new ChatRateLimiter(SETTINGS);
        expect(limiter.attempt('guild', 'vex', 0)).toBe('allow');
        expect(limiter.attempt('guild', 'vex', 1_000)).toBe('allow');
        expect(limiter.attempt('guild', 'vex', 61_000)).toBe('allow');
    });

    it('counts each member separately, per server', () => {
        const limiter = new ChatRateLimiter(SETTINGS);
        limiter.attempt('guild', 'vex', 0);
        limiter.attempt('guild', 'vex', 0);
        expect(limiter.attempt('guild', 'mara', 0)).toBe('allow');
        expect(limiter.attempt('other-guild', 'vex', 0)).toBe('allow');
    });

    it('starts a member over once they have been quiet for a window and any cooldown has ended', () => {
        const limiter = new ChatRateLimiter(SETTINGS);
        limiter.attempt('guild', 'vex', 0);
        limiter.attempt('guild', 'vex', 0);
        expect(limiter.attempt('guild', 'vex', 0)).toBe('warn');
        expect(limiter.attempt('guild', 'vex', 300_000)).toBe('allow');
        expect(limiter.attempt('guild', 'vex', 300_001)).toBe('allow');
        expect(limiter.attempt('guild', 'vex', 300_002)).toBe('warn');
    });
});
