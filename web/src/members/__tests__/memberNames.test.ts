import { zGetMemberNamesQuery, type MemberName } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { isUserId, MEMBER_NAME_IDS_PER_REQUEST, memberNameLabel, memberNameRequests } from '../memberNames';

function name(overrides: Partial<MemberName> = {}): MemberName {
    return {
        userId: '400000000000000001',
        username: 'kittenuser',
        globalName: 'Kitten',
        nickname: 'Brat',
        nicknames: ['Brat'],
        isBot: false,
        inServer: true,
        leftAt: null,
        ...overrides,
    };
}

describe('memberNameLabel', () => {
    it('is the server nickname, else the display name, else the handle', () => {
        expect(memberNameLabel(name())).toBe('Brat');
        expect(memberNameLabel(name({ nickname: null }))).toBe('Kitten');
        expect(memberNameLabel(name({ nickname: '', globalName: null }))).toBe('kittenuser');
    });
});

describe('memberNameRequests', () => {
    it('asks once for each id, in one order, whatever order the view shows them in', () => {
        const ids = ['400000000000000002', '400000000000000001', '400000000000000002'];

        expect(memberNameRequests(ids)).toEqual(['400000000000000001,400000000000000002']);
        expect(memberNameRequests([...ids].reverse())).toEqual(memberNameRequests(ids));
    });

    it('asks nothing for no ids, and leaves out anything that is not a user id', () => {
        expect(memberNameRequests([])).toEqual([]);
        expect(memberNameRequests(['user-1', ''])).toEqual([]);
    });

    it(`splits more than ${MEMBER_NAME_IDS_PER_REQUEST} ids across requests`, () => {
        expect(memberNameRequests(userIds(MEMBER_NAME_IDS_PER_REQUEST)).map(idCount)).toEqual([MEMBER_NAME_IDS_PER_REQUEST]);
        expect(memberNameRequests(userIds(MEMBER_NAME_IDS_PER_REQUEST + 1)).map(idCount)).toEqual([
            MEMBER_NAME_IDS_PER_REQUEST,
            1,
        ]);
    });
});

/**
 * The browser's copy of the route's cap and id shape, held to the route's own rule — the
 * generated `zGetMemberNamesQuery` — so a cap changed there fails here, not as every names
 * request on every page quietly refused.
 */
describe('memberNameRequests against the route', () => {
    it.each([MEMBER_NAME_IDS_PER_REQUEST, MEMBER_NAME_IDS_PER_REQUEST + 1])(
        'builds only requests the route takes, for %i ids',
        (count) => {
            for (const ids of memberNameRequests(userIds(count))) {
                expect(zGetMemberNamesQuery.safeParse({ ids }).success).toBe(true);
            }
        }
    );

    it(`is right that the route refuses ${MEMBER_NAME_IDS_PER_REQUEST + 1} ids in one request`, () => {
        expect(zGetMemberNamesQuery.safeParse({ ids: userIds(MEMBER_NAME_IDS_PER_REQUEST + 1).join(',') }).success).toBe(
            false
        );
    });

    it('agrees with the route on what a user id is', () => {
        for (const id of ['12345678901234567', '12345678901234567890', '1234567890123456', '123456789012345678901', 'abc']) {
            expect(isUserId(id)).toBe(zGetMemberNamesQuery.safeParse({ ids: id }).success);
        }
    });
});

/** `count` distinct user ids. */
function userIds(count: number): string[] {
    return Array.from({ length: count }, (_unused, index) => `4000000000000${String(index).padStart(5, '0')}`);
}

function idCount(request: string): number {
    return request.split(',').length;
}
