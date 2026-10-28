import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FlowRunContext } from '../types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activityEventsRepo } from '../../../../features-system/activity';
import { fakeGuild } from '../../__tests__/support/fakeGuild';
import { effectiveRequirements } from '../../engine/nodeRequirements';
import { block as assignRole } from '../actionAssignRole';
import { block as awardXp } from '../actionAwardXp';
import { block as kickMember } from '../actionKickMember';
import { block as removeRole } from '../actionRemoveRole';
import { block as sendDM } from '../actionSendDM';
import { block as hasOpenTicket } from '../conditionHasOpenTicket';
import { block as hasRole } from '../conditionHasRole';
import { block as isBooster } from '../conditionIsBooster';
import { block as levelAtLeast } from '../conditionLevelAtLeast';
import { block as timeSince } from '../conditionTimeSince';
import { parseNodeConfig, type BlockManifest } from '../manifest';
import { MEMBER_CHOICE_CARD_PART, MEMBER_CHOICE_FIELD, memberFor, type MemberChoice } from '../memberChoice';

/**
 * The member choice: which of a run's two people a block acts on or asks about.
 *
 * Every block that takes it is driven here through the config parse the executor uses,
 * on a run carrying both people, and asked who it touched — so "the chosen person is the
 * one acted on" is one table, not ten tests, and a block that reads the subject behind
 * its choice's back fails by name.
 */

const GUILD_ID = 'guild-1';
const SUBJECT_ID = 'subject-1';
const ACTOR_ID = 'actor-1';
const ROLE_ID = 'role-1';

/** Every user id a block read or acted on, in order — reset before each test. */
const touched = vi.hoisted((): string[] => []);

vi.mock('../../../leveling', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../leveling')>()),
    awardFlowXp: async ({ userId }: { userId: string }) => {
        touched.push(userId);
        return { ok: true };
    },
    loadUserLevelProfile: async (_guildId: string, userId: string) => {
        touched.push(userId);
        return { level: 1 };
    },
}));

vi.mock('../../../tickets', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../tickets')>()),
    findOpenTicket: async (_guildId: string, userId: string) => {
        touched.push(userId);
        return null;
    },
}));

beforeEach(() => {
    touched.length = 0;
    vi.spyOn(activityEventsRepo, 'findLastMessageAt').mockImplementation(async (query) => {
        if (query.userId) touched.push(query.userId);
        return null;
    });
});

/** A member whose every read or change a block makes is recorded against their id. */
function person(id: string) {
    const touch = (): void => {
        touched.push(id);
    };
    return {
        id,
        roles: {
            add: async () => touch(),
            remove: async () => touch(),
            cache: {
                has: () => {
                    touch();
                    return false;
                },
            },
        },
        user: { send: async () => touch() },
        get premiumSince() {
            touch();
            return null;
        },
        get joinedAt() {
            touch();
            return null;
        },
    };
}

function contextWith(people: { readonly subject?: boolean; readonly actor?: boolean } = {}): FlowRunContext {
    const guild = {
        ...fakeGuild({ id: GUILD_ID, roles: [{ id: ROLE_ID }] }),
        members: {
            fetch: async ({ user }: { user: string }) => {
                touched.push(user);
                return { id: user, kickable: true, kick: async () => undefined };
            },
        },
    };
    return {
        client: {} as FlowRunContext['client'],
        guild: guild as unknown as FlowRunContext['guild'],
        ...(people.subject === false ? {} : { subject: person(SUBJECT_ID) as unknown as FlowRunContext['subject'] }),
        ...(people.actor === false ? {} : { actor: person(ACTOR_ID) as unknown as FlowRunContext['actor'] }),
        runId: 'run-1',
        flowId: 'flow-1',
        nodeId: 'node-1',
        chainDepth: 1,
        variables: {},
        setOutput: () => {},
    };
}

/** Run a block on raw node data, parsed exactly as the executor parses it. */
async function runOn(definition: BlockManifest, data: Record<string, unknown>, context = contextWith()) {
    const parsed = parseNodeConfig(definition, data);
    if (!parsed.success) throw new Error(`${definition.type} refused ${JSON.stringify(data)}: ${parsed.error.message}`);
    return definition.run(parsed.data, context);
}

/** Every block taking the choice, with the rest of the node data it needs to run. */
const BLOCKS: readonly { readonly definition: BlockManifest; readonly data: Record<string, unknown> }[] = [
    { definition: assignRole, data: { roleId: ROLE_ID } },
    { definition: removeRole, data: { roleId: ROLE_ID } },
    { definition: awardXp, data: { amount: '100' } },
    { definition: kickMember, data: {} },
    { definition: sendDM, data: { message: 'Miss me?' } },
    { definition: hasRole, data: { roleId: ROLE_ID } },
    { definition: isBooster, data: {} },
    { definition: levelAtLeast, data: { level: '5' } },
    { definition: hasOpenTicket, data: { ticketType: 'support' } },
    { definition: timeSince, data: { source: 'memberMessage', durationMs: 60_000 } },
    { definition: timeSince, data: { source: 'memberJoined', durationMs: 60_000 } },
];

const CASES = BLOCKS.flatMap(({ definition, data }) => {
    const name = `${definition.type}${typeof data.source === 'string' ? ` (${data.source})` : ''}`;
    return [
        { name, choice: 'left unset', data, expected: SUBJECT_ID },
        { name, choice: 'subject', data: { ...data, member: 'subject' }, expected: SUBJECT_ID },
        { name, choice: 'actor', data: { ...data, member: 'actor' }, expected: ACTOR_ID },
    ].map((testCase) => ({ ...testCase, definition }));
});

describe('a block with the member choice acts on the person it names', () => {
    it.each(CASES)('$name, choice $choice, touches only $expected', async ({ definition, data, expected }) => {
        await runOn(definition, data);

        expect(touched).toEqual([expected]);
    });

    it("leaves both people alone where the choice is hidden: Time Since's channel source", async () => {
        await runOn(timeSince, { source: 'runStarted', member: 'actor', durationMs: 60_000 });

        expect(touched).toEqual([]);
    });

    it('gives the actor the role and leaves the subject without it', async () => {
        const context = contextWith();
        const toSubject = vi.spyOn(context.subject?.roles ?? { add: async () => undefined }, 'add');
        const toActor = vi.spyOn(context.actor?.roles ?? { add: async () => undefined }, 'add');

        await runOn(assignRole, { roleId: ROLE_ID, member: 'actor' }, context);

        expect(toActor).toHaveBeenCalledWith(ROLE_ID);
        expect(toSubject).not.toHaveBeenCalled();
    });
});

describe('what the member choice needs from the run', () => {
    const needs = (definition: BlockManifest, data: Record<string, unknown>) =>
        effectiveRequirements(definition, data).map(({ requirement }) => requirement);

    it('needs the member when unset or set to them, and the actor — not the member — when set to whoever set this off', () => {
        expect(needs(assignRole, { roleId: ROLE_ID })).toEqual(['subject']);
        expect(needs(assignRole, { roleId: ROLE_ID, member: 'subject' })).toEqual(['subject']);
        expect(needs(assignRole, { roleId: ROLE_ID, member: 'actor' })).toEqual(['actor']);
    });

    it("needs nobody where the choice is hidden, whatever it still holds", () => {
        expect(needs(timeSince, { source: 'channelMessage', member: 'actor' })).toEqual([]);
        expect(needs(timeSince, { source: 'memberJoined', member: 'actor' })).toEqual(['actor']);
    });
});

describe('memberFor', () => {
    it.each([
        ['subject', SUBJECT_ID],
        ['actor', ACTOR_ID],
    ] as const satisfies readonly (readonly [MemberChoice, string])[])('hands back the %s', (choice, id) => {
        expect(memberFor(contextWith(), choice).id).toBe(id);
    });

    it('fails by name when the chosen person is missing — the requirement check regressed', () => {
        expect(() => memberFor(contextWith({ actor: false }), 'actor')).toThrow(
            /set to act on whoever set this off, and nobody did on this run/
        );
        expect(() => memberFor(contextWith({ subject: false }), 'subject')).toThrow(/this run is about nobody/);
    });
});

/**
 * Which blocks take the choice, read off the blocks themselves rather than a list naming
 * them: a block reading the member through `memberFor` declares the shared field and lets
 * it carry the requirement, and one still reading it through `requireSubject` (its member
 * being the run's by its own rule — Open Ticket) declares `subject` itself. No block reads
 * `context.subject` or `context.actor` directly, which would be a member nothing had
 * checked it has. (Ask a Question and Wait for Event declare `subject` and read neither:
 * the engine keys their waits by the run's member.)
 */
describe('every block reading a member says how it picks them', () => {
    const blocksDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const blockDirectories = readdirSync(blocksDir).filter(
        (entry) => entry !== '__tests__' && statSync(join(blocksDir, entry)).isDirectory()
    );

    async function definitionIn(directory: string): Promise<BlockManifest> {
        const loaded: { readonly block: BlockManifest } = await import(
            pathToFileURL(join(blocksDir, directory, 'index.ts')).href
        );
        return loaded.block;
    }

    const sourceOf = (directory: string): string => readFileSync(join(blocksDir, directory, 'index.ts'), 'utf8');
    const choosing = blockDirectories.filter((directory) => sourceOf(directory).includes('memberFor('));
    const fixed = blockDirectories.filter((directory) => sourceOf(directory).includes('requireSubject('));

    it('finds the blocks it means to', () => {
        expect(choosing).toHaveLength(10);
        expect(fixed.length).toBeGreaterThan(0);
    });

    it.each(choosing)('%s declares the shared choice and leaves the requirement to it', async (directory) => {
        const definition = await definitionIn(directory);
        const field = definition.configFields.find((candidate) => candidate.key === MEMBER_CHOICE_FIELD.key);

        expect(field && { ...field, visibleWhen: undefined }).toEqual({ ...MEMBER_CHOICE_FIELD, visibleWhen: undefined });
        // Named on the card only while it is not the default.
        expect(definition.cardSummary).toContainEqual(MEMBER_CHOICE_CARD_PART);
        expect(definition.requires).not.toContain('subject');
        expect(definition.requires).not.toContain('actor');
    });

    it.each(fixed)('%s, reading the run member directly, declares it needs one', async (directory) => {
        expect((await definitionIn(directory)).requires).toContain('subject');
    });

    it('finds no block reading either person off the context unchecked', () => {
        const direct = /\bcontext\??\.(?:subject|actor)\b|\{[^}]*\b(?:subject|actor)\b[^}]*\}\s*=\s*context\b/;
        expect(blockDirectories.filter((directory) => direct.test(sourceOf(directory)))).toEqual([]);
    });

    /**
     * The builder's palette greys a block whose member choice needs somebody either way on
     * a flow whose runs are about nobody, on the footing that such a flow has nobody
     * acting either (`NodePalette.tsx`). That holds while every trigger naming who acted
     * is also about someone.
     */
    it('finds no trigger that names who acted without saying who the run is about', async () => {
        const definitions = await Promise.all(blockDirectories.map(definitionIn));
        const actorOnly = definitions
            .filter((definition) => definition.kind === 'trigger')
            .filter((definition) => definition.requires.includes('actor') && !definition.requires.includes('subject'))
            .map((definition) => definition.type);

        expect(actorOnly).toEqual([]);
    });
});
