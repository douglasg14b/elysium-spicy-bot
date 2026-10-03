import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    FLOW_MESSAGE_LIMIT_PER_GUILD,
    FLOW_MESSAGE_LIMIT_PER_GUILD_INTERVAL_MS,
    FLOW_MESSAGE_LIMIT_PER_MEMBER,
    FLOW_MESSAGE_LIMIT_PER_MEMBER_INTERVAL_MS,
} from '../../constants';
import { MessageActivityLimit, TokenLimit } from '../messageActivityLimit';

/**
 * The flood limit on message activity, driven with an explicit clock so every count is
 * exact. The live shape — a burst of real messages through the real dispatchers — is in
 * `__tests__/messageSent.test.ts`.
 */

const NOW = 1_000_000;
const GUILD = 'guild-1';

function freshLimit(): MessageActivityLimit {
    return new MessageActivityLimit({
        guild: { limit: FLOW_MESSAGE_LIMIT_PER_GUILD, intervalMs: FLOW_MESSAGE_LIMIT_PER_GUILD_INTERVAL_MS },
        member: { limit: FLOW_MESSAGE_LIMIT_PER_MEMBER, intervalMs: FLOW_MESSAGE_LIMIT_PER_MEMBER_INTERVAL_MS },
        summaryIntervalMs: 60_000,
    });
}

/** How many of `attempts` draws by one member at one instant go ahead. */
function allowed(limit: MessageActivityLimit, userId: string, attempts: number, now = NOW): number {
    let count = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (limit.take(GUILD, userId, 'start', now)) count += 1;
    }
    return count;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the message flood limit', () => {
    it('lets one member start at most their burst, while everyone else still gets through', () => {
        const limit = freshLimit();

        expect(allowed(limit, 'flooder', 20)).toBe(FLOW_MESSAGE_LIMIT_PER_MEMBER);
        expect(allowed(limit, 'bystander', 1)).toBe(1);
    });

    it('caps the whole guild, however many members share the flood', () => {
        const limit = freshLimit();
        let total = 0;
        for (let member = 0; member < 20; member += 1) {
            total += allowed(limit, `member-${member}`, FLOW_MESSAGE_LIMIT_PER_MEMBER);
        }

        expect(total).toBe(FLOW_MESSAGE_LIMIT_PER_GUILD);
        // Another guild has its own share.
        expect(limit.take('guild-2', 'member-0', 'start', NOW)).toBe(true);
    });

    it('does not spend a guild token on a member who has none left', () => {
        // Both checked before either is taken: a flooder refused by their own limit
        // must not keep draining what the rest of the guild has.
        const limit = freshLimit();
        expect(allowed(limit, 'flooder', FLOW_MESSAGE_LIMIT_PER_MEMBER + 100)).toBe(FLOW_MESSAGE_LIMIT_PER_MEMBER);

        let others = 0;
        for (let member = 0; member < 30; member += 1) {
            others += allowed(limit, `member-${member}`, 1);
        }

        expect(others).toBe(FLOW_MESSAGE_LIMIT_PER_GUILD - FLOW_MESSAGE_LIMIT_PER_MEMBER);
    });

    it('gives tokens back with time, without a timer', () => {
        const limit = freshLimit();
        expect(allowed(limit, 'regular', FLOW_MESSAGE_LIMIT_PER_MEMBER + 1)).toBe(FLOW_MESSAGE_LIMIT_PER_MEMBER);

        expect(allowed(limit, 'regular', 1, NOW + FLOW_MESSAGE_LIMIT_PER_MEMBER_INTERVAL_MS - 1)).toBe(0);
        expect(allowed(limit, 'regular', 2, NOW + FLOW_MESSAGE_LIMIT_PER_MEMBER_INTERVAL_MS)).toBe(1);
    });

    it('sums its refusals into one line per guild, then forgets them', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const limit = freshLimit();
        allowed(limit, 'flooder', FLOW_MESSAGE_LIMIT_PER_MEMBER + 3);
        limit.take(GUILD, 'flooder', 'wake', NOW);
        limit.take('guild-2', 'x', 'start', NOW);

        expect(warn).not.toHaveBeenCalled();
        limit.flushSummary();

        expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
            expect.stringMatching(/Message limit: skipped 3 run start\(s\) and 1 wake-up\(s\) in guild guild-1\b/),
        ]);

        limit.flushSummary();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('a token count', () => {
    it('forgets a key once its tokens have all come back, as if it were never seen', () => {
        const tokens = new TokenLimit({ limit: 2, intervalMs: 1000 });
        tokens.take('a', NOW);
        tokens.take('b', NOW);
        tokens.take('b', NOW);

        tokens.sweep(NOW + 1000);
        expect(tokens.size).toBe(1);
        expect(tokens.has('b', NOW + 1000)).toBe(true);

        tokens.sweep(NOW + 2000);
        expect(tokens.size).toBe(0);
    });
});
