import { GuildMember, PermissionsBitField } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../blocks/registry';
import type { FlowRunSeed } from '../blocks/types';
import { TRIGGER_BUTTON_CLICK } from '../blocks/triggerButtonClick';
import {
    ELIGIBILITY_CONFIG_KEY,
    evaluateEligibility,
    OPEN_GATE,
    readEligibility,
    type Eligibility,
} from '../engine/eligibility';
import { handleFlowButtonInteraction } from '../engine/flowTriggerDispatch';
import { buildFlowCustomId } from '../utils/customId';

const GUILD_ID = 'guild-1';
const FLOW_ID = 'flow-1';
const NODE_ID = 'node-1';
const MEMBER_ID = 'member-1';
const MOD_ROLE = 'role-mod';

vi.mock('../data/flowsRepo', () => ({
    flowsRepo: { getByFlowId: (flowId: string) => Promise.resolve(flowFixture?.(flowId) ?? null) },
}));

// Recorded rather than merely stubbed. Waking parked runs is a *side effect of
// the press*, so whether it happens for a refused press is exactly the question
// "refusal changes nothing" answers — a stub that silently swallowed the call
// would make that claim untestable.
vi.mock('../engine/waitingRunDispatch', () => ({
    resumeWaitingRunsForEvent: () => {
        woken.push(true);
        return Promise.resolve(0);
    },
}));

vi.mock('../engine/executor', () => ({
    executeFlow: (...args: unknown[]) => {
        executed.push(args);
        return Promise.resolve({ status: 'success' });
    },
}));

let flowFixture: ((flowId: string) => unknown) | undefined;
const executed: unknown[][] = [];
const woken: true[] = [];

describe('who a rule admits', () => {
    it('lets anybody through the open rule, which is what an unset one means', () => {
        expect(evaluateEligibility(OPEN_GATE, { candidate: member() }).allowed).toBe(true);
        // An absent key is the open rule: every graph authored before this
        // existed has no key, and reading those as closed would break them all.
        expect(readEligibility({})).toEqual(OPEN_GATE);
        expect(readEligibility({ label: 'Press me' })).toEqual(OPEN_GATE);
    });

    it('admits on any one of the listed roles, not all of them', () => {
        const rule: Eligibility = { principal: 'roles', roleIds: [MOD_ROLE, 'role-vip'] };

        expect(evaluateEligibility(rule, { candidate: member({ roles: ['role-vip'] }) }).allowed).toBe(true);
        expect(evaluateEligibility(rule, { candidate: member({ roles: ['role-other'] }) }).allowed).toBe(false);
    });

    it('reads effective permissions, so an administrator passes a rule naming any of them', () => {
        // The whole reason `member.permissions` is asked rather than the roles
        // being walked by hand: Administrator implies everything, and a guild
        // owner holds it without any role saying so.
        const rule: Eligibility = { principal: 'discordPermission', permissions: ['ManageMessages'] };
        const admin = member({ permissions: PermissionsBitField.Flags.Administrator });

        expect(evaluateEligibility(rule, { candidate: admin }).allowed).toBe(true);
        expect(evaluateEligibility(rule, { candidate: member() }).allowed).toBe(false);
    });

    it('refuses a rule it cannot evaluate rather than falling open', () => {
        // The asymmetry the whole design turns on. A `subject` rule with no
        // subject, and a `variable` rule whose variable is unset, are both rules
        // whose condition cannot be *shown* to hold — and a check that admits
        // when it cannot tell is not a check.
        const candidate = member();

        expect(evaluateEligibility({ principal: 'subject' }, { candidate }).allowed).toBe(false);
        expect(evaluateEligibility({ principal: 'actor' }, { candidate }).allowed).toBe(false);
        expect(
            evaluateEligibility({ principal: 'variable', variable: 'winner' }, { candidate, variables: {} }).allowed
        ).toBe(false);
    });

    it('will not match a member id that arrived as a number', () => {
        // A snowflake past 2^53 is already the wrong id by the time it is a
        // number, so coercing one to compare it could admit on a near miss. It
        // is refused instead, and the string form still admits.
        const candidate = member();
        const asNumber = { candidate, variables: { winner: Number(MEMBER_ID.length) } };
        const asString = { candidate, variables: { winner: MEMBER_ID } };
        const rule: Eligibility = { principal: 'variable', variable: 'winner' };

        expect(evaluateEligibility(rule, asNumber).allowed).toBe(false);
        expect(evaluateEligibility(rule, asString).allowed).toBe(true);
    });

    it('reports a rule it cannot parse as unreadable rather than as open', () => {
        // Only reachable by writing to the database directly — save-time
        // validation refuses these — but the direction of the guess is what
        // matters: an unreadable rule has no meaning, and guessing "open" on a
        // permission check guesses in favour of whoever is pressing.
        expect(readEligibility({ [ELIGIBILITY_CONFIG_KEY]: { principal: 'sudo' } })).toBeNull();
        expect(readEligibility({ [ELIGIBILITY_CONFIG_KEY]: { principal: 'roles', roleIds: [] } })).toBeNull();
        expect(readEligibility({ [ELIGIBILITY_CONFIG_KEY]: 'anyone' })).toBeNull();
    });
});

describe('pressing a gated trigger button', () => {
    // The dispatcher asks the registry whether the node is a buttonClick trigger,
    // and the registry refuses to be read before discovery — deliberately, so a
    // half-loaded registry can never answer "no such block" about a real one.
    beforeAll(async () => {
        await ensureBlocksDiscovered();
    });

    it('runs the flow for a member the rule admits, and not for one it refuses', async () => {
        flowFixture = () => gatedFlow({ principal: 'roles', roleIds: [MOD_ROLE] });
        executed.length = 0;

        const admitted = await handleFlowButtonInteraction(press(member({ roles: [MOD_ROLE] })));
        expect(admitted.status).toBe('success');
        expect(executed).toHaveLength(1);

        const refused = await handleFlowButtonInteraction(press(member()));
        // `skipped`, not `error`: a rule doing its job is the system working, and
        // logging every refused press as a failure buries real ones.
        expect(refused.status).toBe('skipped');
        // The refusal changed nothing — the flow never ran.
        expect(executed).toHaveLength(1);
    });

    it('does not wake the refused member own parked runs', async () => {
        // The press has a second side effect besides starting the flow: it wakes
        // any run of *this member's* parked on a button click. That wake matches
        // on guild, wait kind and member — never on which button was pressed — so
        // running it before the rule is consulted would let a refused press
        // advance the presser's runs, assigning roles and sending messages while
        // reporting itself as "skipped, nothing happened".
        flowFixture = () => gatedFlow({ principal: 'roles', roleIds: [MOD_ROLE] });
        woken.length = 0;

        await handleFlowButtonInteraction(press(member()));
        expect(woken).toHaveLength(0);

        await handleFlowButtonInteraction(press(member({ roles: [MOD_ROLE] })));
        expect(woken).toHaveLength(1);
    });

    it('still wakes parked runs when the flow itself is unhealthy', async () => {
        // The other half of the ordering, and the one a first attempt at this got
        // wrong. A deleted or disabled flow is not a refusal of *this member* —
        // the wake matches on guild, wait kind and member, never on which button,
        // so any press was always meant to advance their own parked run. Skipping
        // it here would leave that run parked with nothing left to wake it.
        woken.length = 0;

        flowFixture = () => ({ ...gatedFlow(OPEN_GATE), enabled: false });
        const disabled = await handleFlowButtonInteraction(press(member()));
        expect(disabled.status).toBe('error');

        flowFixture = () => null;
        await handleFlowButtonInteraction(press(member()));

        expect(woken).toHaveLength(2);
    });

    it('refuses a press before deferring, so nothing is left thinking', async () => {
        flowFixture = () => gatedFlow({ principal: 'roles', roleIds: [MOD_ROLE] });
        const interaction = press(member());

        await handleFlowButtonInteraction(interaction);

        // Replied outright rather than acknowledged-then-followed-up. A refusal is
        // immediate — there is no work to wait on — and acknowledging first would
        // make the "no" arrive as a second, detached message.
        //
        // This matters more since success went silent: `deferUpdate` closes the
        // interaction with nothing shown, so a refusal that ran after it would
        // depend entirely on the follow-up landing to say anything at all.
        expect(interaction.deferUpdate).not.toHaveBeenCalled();
        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ ephemeral: true })
        );
    });
});

/** A guild member with only what a rule reads, and a real prototype to narrow on. */
function member({
    id = MEMBER_ID,
    roles = [],
    permissions = 0n,
}: { id?: string; roles?: readonly string[]; permissions?: bigint } = {}): GuildMember {
    const built = Object.create(GuildMember.prototype) as GuildMember;
    // Each of these is a prototype *getter* on a real member, and assigning over
    // a getter throws — so they are defined as own properties instead.
    Object.defineProperties(built, {
        user: { value: { id } },
        id: { value: id },
        roles: { value: { cache: new Map(roles.map((roleId) => [roleId, { id: roleId }])) } },
        permissions: { value: new PermissionsBitField(permissions) },
    });
    return built;
}

/** A one-node flow whose trigger carries the given rule. */
function gatedFlow(rule: Eligibility) {
    return {
        flowId: FLOW_ID,
        guildId: GUILD_ID,
        enabled: true,
        graph: {
            nodes: [
                {
                    id: NODE_ID,
                    type: TRIGGER_BUTTON_CLICK,
                    data: {
                        channelId: 'channel-1',
                        label: 'Press me',
                        style: 'Primary',
                        [ELIGIBILITY_CONFIG_KEY]: rule,
                    },
                },
            ],
            edges: [],
        },
    };
}

function press(pressingMember: GuildMember) {
    return {
        customId: buildFlowCustomId(FLOW_ID, NODE_ID),
        isButton: () => true,
        deferred: false,
        replied: false,
        guild: { id: GUILD_ID },
        member: pressingMember,
        user: { id: pressingMember.id },
        channel: null,
        client: {} as FlowRunSeed['client'],
        deferReply: vi.fn().mockResolvedValue(undefined),
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof handleFlowButtonInteraction>[0] & {
        deferReply: ReturnType<typeof vi.fn>;
        deferUpdate: ReturnType<typeof vi.fn>;
        followUp: ReturnType<typeof vi.fn>;
        reply: ReturnType<typeof vi.fn>;
    };
}
