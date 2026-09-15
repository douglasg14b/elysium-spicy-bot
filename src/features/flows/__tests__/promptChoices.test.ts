import { GuildMember, PermissionsBitField, type ButtonInteraction, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
    ACTION_PROMPT,
    block as promptBlock,
    promptChoiceHandle,
    promptConfigSchema,
    PROMPT_TIMEOUT_HANDLE,
    type PromptConfig,
} from '../blocks/actionPrompt';
import type { FlowRunContext } from '../blocks/types';
import { DISCORD_CUSTOM_ID_MAX_LENGTH, FLOW_CHOICE_CUSTOM_ID_PREFIX } from '../constants';
import type { FlowEntity } from '../data/flowsSchema';
import { ELIGIBILITY_CONFIG_KEY, OPEN_GATE, type Eligibility } from '../engine/eligibility';
import {
    handleFlowChoiceInteraction,
    QUESTION_CLOSED_MESSAGE,
    type FlowChoiceDependencies,
} from '../engine/flowChoiceDispatch';
import { buildFlowChoiceCustomId, parseFlowChoiceCustomId, buildFlowCustomId } from '../utils/customId';
import type { FlowRunEntity } from '../data/flowRunsSchema';

const RUN_ID = 'run-1';
const NODE_ID = 'node-1';
const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
/** The message the parked question was posted on, and its buttons belong to. */
const MESSAGE_ID = 'message-1';

describe('a choice button id', () => {
    it('survives the round trip Discord puts it through', () => {
        const built = buildFlowChoiceCustomId(RUN_ID, NODE_ID, 3);

        expect(parseFlowChoiceCustomId(built)).toEqual({ runId: RUN_ID, nodeId: NODE_ID, index: 3 });
    });

    it('refuses to be built at all rather than being silently truncated', () => {
        // A truncated id parses to a different node, or to none — so it would
        // advance the wrong branch of the right run, which is worse than a
        // question that fails to post and names why.
        const overlongNode = 'n'.repeat(DISCORD_CUSTOM_ID_MAX_LENGTH);

        expect(() => buildFlowChoiceCustomId(RUN_ID, overlongNode, 0)).toThrow(/over Discord's 100/);
    });

    it('rejects ids that did not come from the builder', () => {
        // `Number` alone takes all three of these and names choice 1, while no
        // button this engine builds is labelled any of them.
        for (const rawIndex of ['1e0', ' 1', '1.0', 'x']) {
            expect(parseFlowChoiceCustomId(`${FLOW_CHOICE_CUSTOM_ID_PREFIX}:${RUN_ID}:${NODE_ID}:${rawIndex}`)).toBeNull();
        }
        // A trigger id has three segments, not four.
        expect(parseFlowChoiceCustomId(buildFlowCustomId('flow-1', NODE_ID))).toBeNull();
    });
});

/*
 * There is deliberately **no routing test** for `flow:` versus `flowc:`.
 *
 * One was written and then deleted, because it could not fail. As both are
 * registered — each with its trailing colon — `'flowc:…'.startsWith('flow:')` is
 * false, so the two prefix sets are disjoint and no dispatch rule arbitrates
 * between them. A test asserting each id reaches its own handler still passed
 * with longest-prefix-wins inverted in the registry, and with either prefix
 * registered bare: it was pinning arithmetic, not behaviour, while reading as
 * though it guarded a hazard.
 *
 * Recorded rather than silently dropped, so the next author who notices the gap
 * does not write the same test again. What the ids must actually do — round-trip
 * intact, and reject anything this engine did not build — is checked above.
 */

describe('answering a question', () => {
    it('resumes the presser own run down the handle they picked', async () => {
        const resume = vi.fn().mockResolvedValue({ status: 'completed' });
        const interaction = buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 2));

        const result = await handleFlowChoiceInteraction(interaction, {
            flowRunsRepo: { getByRunId: () => Promise.resolve(parkedRun()) },
            flowsRepo: openGateFlow(),
            resume: resume as never,
        });

        expect(result.status).toBe('success');
        expect(resume).toHaveBeenCalledWith(
            interaction.client,
            expect.objectContaining({ runId: RUN_ID }),
            { kind: 'choice', index: 2 },
            undefined,
            // The park the press names, handed to the claim so the conditional
            // write itself refuses a button from an earlier asking.
            MESSAGE_ID
        );
    });

    it('says nothing to a member whose answer worked', async () => {
        // The complaint this pins: pressing the right button posted an ephemeral
        // "✅ Got it." on top of whatever the flow had just visibly done in the
        // channel — a popup confirming what the member had watched happen.
        //
        // Silence here is only possible because the acknowledgement is
        // `deferUpdate`. `deferReply` promises a reply and Discord obliges one, so
        // reinstating it would quietly bring the popup back; asserting on both is
        // what makes this test fail for the right reason.
        const interaction = buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0));

        const result = await handleFlowChoiceInteraction(interaction, {
            flowRunsRepo: { getByRunId: () => Promise.resolve(parkedRun()) },
            flowsRepo: openGateFlow(),
            resume: vi.fn().mockResolvedValue({ status: 'completed' }) as never,
        });

        expect(result.status).toBe('success');
        expect(interaction.deferUpdate).toHaveBeenCalled();
        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(interaction.followUp).not.toHaveBeenCalled();
        expect(interaction.editReply).not.toHaveBeenCalled();
        expect(interaction.reply).not.toHaveBeenCalled();

        // And nothing for the registry to send on the handler's behalf either —
        // it auto-replies with `result.message` when one comes back.
        expect(result.message).toBeUndefined();
    });

    it('still speaks up when something actually goes wrong', async () => {
        // The other half of the same decision. Going quiet on success must not go
        // quiet on a fault: the member pressed a button, nothing visible happened,
        // and silence there would read as the bot being broken.
        const interaction = buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0));

        const result = await handleFlowChoiceInteraction(interaction, {
            flowRunsRepo: { getByRunId: () => Promise.resolve(parkedRun()) },
            flowsRepo: openGateFlow(),
            resume: vi.fn().mockResolvedValue({ status: 'failed', error: 'boom' }) as never,
        });

        expect(result.status).toBe('error');
        // `followUp`, not `editReply`: after `deferUpdate` there is no reply to
        // edit, and editing would rewrite the message the button sits on — which
        // would blank the question itself.
        expect(interaction.followUp).toHaveBeenCalledWith(
            expect.objectContaining({ ephemeral: true })
        );
        expect(interaction.editReply).not.toHaveBeenCalled();
    });

    it('tells a presser whose question is not written yet apart from one whose question is gone', async () => {
        // The run id is minted before the row exists, so a press landing in that
        // window finds nothing. Reporting it as "gone" would send somebody
        // looking for a deletion that never happened.
        const notYet = await handleFlowChoiceInteraction(buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0)), {
            flowRunsRepo: { getByRunId: () => Promise.resolve(null) },
            flowsRepo: openGateFlow(),
            resume: vi.fn() as never,
        });

        const closed = await handleFlowChoiceInteraction(buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0)), {
            flowRunsRepo: { getByRunId: () => Promise.resolve({ ...parkedRun(), status: 'completed' }) },
            flowsRepo: openGateFlow(),
            resume: vi.fn() as never,
        });

        // Neither promises the other's fix: a missing row may be a question
        // mid-write or one that is gone, and retrying only helps the first. So the
        // two say different things, and neither is the failure copy.
        expect(notYet.message).not.toEqual(closed.message);
        expect(closed.message).toEqual(QUESTION_CLOSED_MESSAGE);
        expect([notYet.status, closed.status]).toEqual(['skipped', 'skipped']);
    });

    it('refuses an answer from the right member when the question narrows further', async () => {
        // Eligibility can only *narrow* here: the ownership check above already
        // proved this is the presser's own question. What it adds is a second
        // condition on that same person — "and only while they hold the role".
        const resume = vi.fn();

        const result = await handleFlowChoiceInteraction(
            buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0)),
            {
                flowRunsRepo: { getByRunId: () => Promise.resolve(parkedRun()) },
                flowsRepo: gatedFlow({ principal: 'roles', roleIds: ['role-they-lack'] }),
                resume: resume as never,
            }
        );

        // `skipped`, not `error` — a rule doing its job is not a fault.
        expect(result.status).toBe('skipped');
        expect(resume).not.toHaveBeenCalled();
    });

    it('still answers an ungated question when the gateway has no cached member', async () => {
        // `interaction.member` arrives as a raw API object whenever the member is
        // not cached. An open rule reads nothing off it, so this must not become a
        // reason a question that always worked suddenly fails — which it would if
        // the narrowing ran before the open case was answered.
        const resume = vi.fn().mockResolvedValue({ status: 'completed' });
        const uncached = buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0));
        Object.assign(uncached, { member: { user: { id: USER_ID }, roles: ['role-1'] } });

        const result = await handleFlowChoiceInteraction(uncached, {
            flowRunsRepo: { getByRunId: () => Promise.resolve(parkedRun()) },
            flowsRepo: openGateFlow(),
            resume: resume as never,
        });

        expect(result.status).toBe('success');
        expect(resume).toHaveBeenCalled();
    });

    it('refuses a press on a question the run has already moved past', async () => {
        // The stale-control case, from the presser's side. The run has answered,
        // carried on, and asked again — so it is `suspended` at the same node once
        // more, and a button left over from the first asking passes every other
        // check. What it cannot do is name the message the run is waiting on now.
        const resume = vi.fn();
        const askedAgain: FlowRunEntity = { ...parkedRun(), waitMessageId: 'message-second' };

        const result = await handleFlowChoiceInteraction(
            buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0), guildMember(), MESSAGE_ID),
            {
                flowRunsRepo: { getByRunId: () => Promise.resolve(askedAgain) },
                flowsRepo: openGateFlow(),
                resume: resume as never,
            }
        );

        // Quietly, and as an ordinary outcome rather than a fault — this is the
        // question having closed, not anything going wrong.
        expect(result.status).toBe('skipped');
        expect(result.message).toEqual(QUESTION_CLOSED_MESSAGE);
        // The assertion that matters: it did not advance the run a second time.
        expect(resume).not.toHaveBeenCalled();
    });

    it('still answers a question parked before a park could name its message', async () => {
        // A row written before `waitMessageId` existed has none, while its buttons
        // are still live in the channel. Claiming it against the message the press
        // came from would match nothing and refuse that member forever, on a
        // question that is genuinely open — so the park name is withheld and the
        // run keeps exactly the guarantees it shipped with.
        const resume = vi.fn().mockResolvedValue({ status: 'completed' });
        const beforeTheColumn: FlowRunEntity = { ...parkedRun(), waitMessageId: null };

        const result = await handleFlowChoiceInteraction(
            buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0), guildMember(), 'message-whatever'),
            {
                flowRunsRepo: { getByRunId: () => Promise.resolve(beforeTheColumn) },
                flowsRepo: openGateFlow(),
                resume: resume as never,
            }
        );

        expect(result.status).toBe('success');
        expect(resume).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            undefined,
            undefined
        );
    });

    it('does not let one member answer a question put to another', async () => {
        const resume = vi.fn();
        const somebodyElse: FlowRunEntity = {
            ...parkedRun(),
            contextSnapshot: { guildId: GUILD_ID, userId: 'somebody-else' },
        };

        const result = await handleFlowChoiceInteraction(buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0)), {
            flowRunsRepo: { getByRunId: () => Promise.resolve(somebodyElse) },
            flowsRepo: openGateFlow(),
            resume: resume as never,
        });

        expect(result.status).toBe('error');
        expect(resume).not.toHaveBeenCalled();
    });
});

describe('the prompt block', () => {
    it('leaves by the handle matching the answer, and by timeout when nobody answers', async () => {
        const config = promptConfig({ question: 'Well?', choices: ['Yes', 'No', 'Maybe'] });

        expect(await promptBlock.run(config, resumedWith({ kind: 'choice', index: 2 }))).toEqual({
            kind: 'continue',
            handle: promptChoiceHandle(2),
        });
        expect(await promptBlock.run(config, resumedWith({ kind: 'timeout' }))).toEqual({
            kind: 'continue',
            handle: PROMPT_TIMEOUT_HANDLE,
        });
    });

    it('fails rather than guessing when the answer no longer exists', async () => {
        // The author deleted a choice while somebody had the question open. The
        // button they are holding names a branch that is gone, and continuing by
        // any handle would route them down one the author never drew for it.
        const shrunk = promptConfig({ question: 'Well?', choices: ['Yes'] });

        expect(await promptBlock.run(shrunk, resumedWith({ kind: 'choice', index: 4 }))).toEqual({
            kind: 'fail',
            error: expect.stringContaining('no longer one of this question'),
        });
    });

    it('posts one button per authored answer, not one per declared handle', async () => {
        // The block declares five choice handles whatever the author wrote. A
        // button built from a handle rather than from the list would let somebody
        // press an answer that was never offered, and `wokeOntoNothing` would
        // fail their run for leaving by an unwired handle.
        const send = vi.fn().mockResolvedValue({ id: MESSAGE_ID });

        const outcome = await promptBlock.run(
            promptConfig({ question: 'Well?', choices: ['Yes', 'No'] }),
            { ...runContext(), channel: { send } as unknown as FlowRunContext['channel'] }
        );

        // The park names the message it just posted. That is what a later press
        // has to match to prove it is answering *this* asking rather than a
        // previous one at the same node.
        expect(outcome).toEqual({
            kind: 'suspend',
            suspension: { wakeAt: undefined, waitMessageId: MESSAGE_ID },
        });
        const posted = send.mock.calls[0]?.[0] as { components: [{ components: { data: { label: string } }[] }] };
        expect(posted.components[0].components.map((button) => button.data.label)).toEqual(['Yes', 'No']);
    });
});

/**
 * A prompt config, through the block's own schema.
 *
 * Parsed rather than written out, so these tests seed exactly what the executor
 * hands `run` — including the eligibility default, which the schema supplies
 * and no author has to type. Writing the defaults in by hand would make every
 * test a place the defaults could drift from the schema.
 */
function promptConfig(authored: { question: string; choices: string[] }): PromptConfig {
    return promptConfigSchema.parse(authored);
}

/**
 * A flow whose prompt node lets anybody answer.
 *
 * Eligibility is checked against the node's own data, so every test that is not
 * about gating still needs a graph to read a rule off. Open, so those tests
 * exercise the path they are actually about — the rule's own behaviour is
 * `eligibility.test.ts`'s subject.
 */
function openGateFlow(): FlowChoiceDependencies['flowsRepo'] {
    return gatedFlow(OPEN_GATE);
}

/** A flow whose prompt node carries the given rule. */
function gatedFlow(rule: Eligibility): FlowChoiceDependencies['flowsRepo'] {
    return {
        getByFlowId: () =>
            Promise.resolve({
                graph: {
                    nodes: [
                        { id: NODE_ID, type: ACTION_PROMPT, data: { [ELIGIBILITY_CONFIG_KEY]: rule } },
                    ],
                },
            } as unknown as FlowEntity),
    };
}

/** A run parked at the prompt node, as the dispatcher would read it back. */
function parkedRun(): FlowRunEntity {
    return {
        runId: RUN_ID,
        guildId: GUILD_ID,
        status: 'suspended',
        resumeNodeId: NODE_ID,
        // The park names the message its buttons are on, so a press can be held
        // to the asking it actually belongs to.
        waitMessageId: MESSAGE_ID,
        contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
    } as unknown as FlowRunEntity;
}

/**
 * A member the eligibility check will accept as real.
 *
 * `Object.create` rather than a cast, because the dispatcher narrows with
 * `instanceof GuildMember` — a plain object literal fails that however it is
 * typed, which is the guard doing its job rather than a fixture inconvenience.
 * Discord.js's constructor wants a live client, so the prototype is borrowed and
 * only the members a gate reads are filled in.
 */
function guildMember(userId: string = USER_ID, roleIds: readonly string[] = []): GuildMember {
    const member = Object.create(GuildMember.prototype) as GuildMember;
    // Everything a gate reads is a prototype *getter* on a real member, and
    // assigning over a getter throws — so each is defined as an own property
    // instead. `id` is among them, reading through to `user.id`, which is why
    // both are set rather than just one.
    Object.defineProperties(member, {
        user: { value: { id: userId } },
        id: { value: userId },
        roles: { value: { cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])) } },
        permissions: { value: new PermissionsBitField() },
    });
    return member;
}

function buttonInteraction(
    customId: string,
    member: GuildMember = guildMember(),
    messageId: string = MESSAGE_ID
): ButtonInteraction {
    /*
     * Starts undeferred, and `deferUpdate` flips the flag — which is what Discord
     * does, and what decides whether a later message goes out as a reply or a
     * follow-up. This fixture used to hard-code `deferred: true`, so the
     * acknowledgement branch was never entered by any test and the choice between
     * `deferReply` and `deferUpdate` was invisible to the suite.
     */
    const state = { deferred: false, replied: false };
    return {
        customId,
        isButton: () => true,
        get deferred() {
            return state.deferred;
        },
        get replied() {
            return state.replied;
        },
        guild: { id: GUILD_ID },
        member,
        // Which message the press came from. Discord always supplies this on a
        // component interaction, and it is how a press is tied to one asking.
        message: { id: messageId },
        user: { id: USER_ID },
        client: {} as Client,
        deferReply: vi.fn().mockImplementation(() => {
            state.deferred = true;
            return Promise.resolve(undefined);
        }),
        deferUpdate: vi.fn().mockImplementation(() => {
            state.deferred = true;
            return Promise.resolve(undefined);
        }),
        editReply: vi.fn().mockResolvedValue(undefined),
        // The dispatcher acknowledges with `deferUpdate`, which leaves no reply to
        // edit, so anything it needs to say afterwards goes out as a follow-up.
        followUp: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockImplementation(() => {
            state.replied = true;
            return Promise.resolve(undefined);
        }),
    } as unknown as ButtonInteraction;
}

function runContext(): FlowRunContext {
    return {
        client: {} as FlowRunContext['client'],
        guild: { id: GUILD_ID } as FlowRunContext['guild'],
        subject: {} as FlowRunContext['subject'],
        runId: RUN_ID,
        nodeId: NODE_ID,
        variables: {},
        setOutput: () => {},
    };
}

function resumedWith(resume: FlowRunContext['resume']): FlowRunContext {
    return { ...runContext(), resume };
}
