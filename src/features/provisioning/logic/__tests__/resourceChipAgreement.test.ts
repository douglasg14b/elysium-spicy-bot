import { describe, expect, it } from 'vitest';
import { detectResourceProblems } from '../../../../../web/src/flows/detectResourceProblems';
import { RESOURCE_CHIPS } from '../../../../../web/src/flows/resourceChips';
import type { ResourceDeclaration as BrowserResourceDeclaration } from '../../../../../web/src/api/types';
import { resourceSchema } from '../../../../web/api/journeyRoutes';
import { declaredRoleReference } from '../declaredRoleReference';
import { validateJourneyDeclaration, type JourneyDeclaration } from '../resourceDeclaration';

/**
 * The red chips are a promise about the server, and this is where the promise is kept.
 *
 * `web/src/flows/detectResourceProblems.ts` says, of some declarations, "the save will
 * refuse this". It cannot call the code that would refuse — a `src/` import inside
 * `web/` drags the bot tree into `tsc -b` and breaks `pnpm build:web`, which is the
 * trade `web/src/api/types.ts` documents — so it re-implements the rules, and this
 * test holds the two halves equal instead of the compiler.
 *
 * It lives on the **server** side of the boundary because imports run that way: a test
 * under `src/` may read `web/`, as `nodeDescriptorDrift.test.ts` and
 * `declaredRoleReference.test.ts` already do. The reverse is what breaks the build.
 *
 * Both directions are asserted, and the second is the one that matters more:
 *
 *  - a declaration the detector calls an **error** must really be rejected — otherwise
 *    a red chip blocks an operator from saving something that would have worked;
 *  - a declaration the detector calls **clean** must really be accepted — otherwise the
 *    save fails with a server banner on a modal showing no problems at all, which is
 *    the state this whole vocabulary exists to prevent.
 */

/** What the server does with a declaration: both gates, in the order the route runs them. */
type ServerVerdict = { accepted: true } | { accepted: false; reason: string };

function serverVerdict(resources: readonly BrowserResourceDeclaration[]): ServerVerdict {
    // Gate one: the Zod schema on each resource. The route parses the array, so one
    // bad member rejects the whole save.
    for (const resource of resources) {
        const parsed = resourceSchema.safeParse(resource);
        if (!parsed.success) {
            return { accepted: false, reason: parsed.error.issues[0]?.message ?? 'schema' };
        }
    }

    // Gate two: the whole-journey invariants, which are the ones no single resource
    // can answer. The journey key is the flow's own id on the real path.
    const journey: JourneyDeclaration = {
        journeyKey: 'flow-1',
        name: 'Flow 1',
        resources: resources as JourneyDeclaration['resources'],
    };

    try {
        validateJourneyDeclaration(journey);
        return { accepted: true };
    } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : 'unknown' };
    }
}

/** Whether the browser would put at least one red chip on this list. */
function browserSeesError(resources: readonly BrowserResourceDeclaration[]): boolean {
    return detectResourceProblems(resources).some((entry) =>
        entry.chips.some((chip) => RESOURCE_CHIPS[chip.id].tone === 'error')
    );
}

function channel(
    overrides: Partial<BrowserResourceDeclaration> = {}
): BrowserResourceDeclaration {
    return { key: 'questions', kind: 'textChannel', defaultName: 'questions', ...overrides };
}

/**
 * Declarations the server refuses, each named by the chip that should have warned.
 *
 * Every error-tier chip appears here at least once. A chip with no row is a claim
 * nothing has checked.
 */
const REJECTED: readonly { chip: string; resources: BrowserResourceDeclaration[] }[] = [
    {
        chip: 'duplicateKey',
        resources: [channel({ key: 'aftercare' }), channel({ key: 'aftercare' })],
    },
    {
        chip: 'duplicateAdoption',
        resources: [
            channel({ key: 'rules', adoptDiscordId: '100000000000000001' }),
            channel({ key: 'rules-copy', adoptDiscordId: '100000000000000001' }),
        ],
    },
    { chip: 'invalidKey (underscore)', resources: [channel({ key: 'qa_channel' })] },
    { chip: 'invalidKey (uppercase)', resources: [channel({ key: 'QaChannel' })] },
    { chip: 'invalidKey (empty)', resources: [channel({ key: '' })] },
    { chip: 'invalidKey (too long)', resources: [channel({ key: 'a'.repeat(65) })] },
    { chip: 'invalidKey (empty name)', resources: [channel({ defaultName: '' })] },
    { chip: 'invalidKey (name too long)', resources: [channel({ defaultName: 'x'.repeat(101) })] },
    {
        chip: 'ruleNamesNoRole (no ids)',
        resources: [
            channel({ permissions: [{ audience: 'roles', roleIds: [], access: 'readWrite' }] }),
        ],
    },
    {
        chip: 'ruleNamesNoRole (undeclared key)',
        resources: [
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('deleted-role')],
                        access: 'readWrite',
                    },
                ],
            }),
        ],
    },
    {
        chip: 'ruleNamesNoRole (key is not a role)',
        resources: [
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('arrivals')],
                        access: 'readWrite',
                    },
                ],
            }),
        ],
    },
];

/**
 * Declarations the server accepts — including every *warning* case.
 *
 * The amber tier is the delicate half. `permissions: []`, a `subject` audience and an
 * adopted resource carrying rules are all saveable and installable; promoting any of
 * them to red would block a save the server would have honoured.
 */
const ACCEPTED: readonly { name: string; resources: BrowserResourceDeclaration[] }[] = [
    { name: 'a plain created channel', resources: [channel()] },
    {
        name: 'a channel inside a declared category',
        resources: [
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
            channel({ parentKey: 'arrivals' }),
        ],
    },
    { name: 'permissions: [] — nobody can see this', resources: [channel({ permissions: [] })] },
    {
        name: 'a subject audience — per-run only',
        resources: [channel({ permissions: [{ audience: 'subject', access: 'readWrite' }] })],
    },
    {
        name: 'an adopted channel carrying rules — permissions untouched',
        resources: [
            channel({
                adoptDiscordId: '100000000000000001',
                permissions: [{ audience: 'everyone', access: 'hidden' }],
            }),
        ],
    },
    {
        name: 'a rule naming a role the flow declares',
        resources: [
            { key: 'in-approval', kind: 'role', defaultName: 'In Approval' },
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('in-approval')],
                        access: 'readWrite',
                    },
                ],
            }),
        ],
    },
    {
        name: 'a rule naming a real guild role by snowflake',
        resources: [
            channel({
                permissions: [
                    { audience: 'roles', roleIds: ['847263518290110'], access: 'readWrite' },
                ],
            }),
        ],
    },
    {
        name: 'two channels adopting different objects',
        resources: [
            channel({ key: 'rules', adoptDiscordId: '100000000000000001' }),
            channel({ key: 'welcome', adoptDiscordId: '100000000000000002' }),
        ],
    },
    { name: 'a key at exactly the 64-character cap', resources: [channel({ key: 'a'.repeat(64) })] },
    {
        name: 'a name at exactly the 100-character cap',
        resources: [channel({ defaultName: 'x'.repeat(100) })],
    },
];

describe('red chips agree with the server', () => {
    it.each(REJECTED)('the server really rejects what $chip claims it will', ({ resources }) => {
        expect(serverVerdict(resources).accepted).toBe(false);
    });

    it.each(REJECTED)('the browser flags $chip before the save is attempted', ({ resources }) => {
        expect(browserSeesError(resources)).toBe(true);
    });
});

describe('the absence of a red chip agrees with the server', () => {
    it.each(ACCEPTED)('the server accepts $name', ({ resources }) => {
        const verdict = serverVerdict(resources);
        expect(verdict.accepted, verdict.accepted ? '' : verdict.reason).toBe(true);
    });

    it.each(ACCEPTED)('the browser shows no red chip on $name', ({ resources }) => {
        expect(browserSeesError(resources)).toBe(false);
    });
});
