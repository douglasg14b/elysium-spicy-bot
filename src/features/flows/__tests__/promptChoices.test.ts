import type { ButtonInteraction, Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { block as promptBlock, promptChoiceHandle, PROMPT_TIMEOUT_HANDLE } from '../blocks/actionPrompt';
import type { FlowRunContext } from '../blocks/types';
import { DISCORD_CUSTOM_ID_MAX_LENGTH, FLOW_CHOICE_CUSTOM_ID_PREFIX } from '../constants';
import { handleFlowChoiceInteraction, QUESTION_CLOSED_MESSAGE } from '../engine/flowChoiceDispatch';
import { buildFlowChoiceCustomId, parseFlowChoiceCustomId, buildFlowCustomId } from '../utils/customId';
import type { FlowRunEntity } from '../data/flowRunsSchema';

const RUN_ID = 'run-1';
const NODE_ID = 'node-1';
const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

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
            resume: resume as never,
        });

        expect(result.status).toBe('success');
        expect(resume).toHaveBeenCalledWith(interaction.client, expect.objectContaining({ runId: RUN_ID }), {
            kind: 'choice',
            index: 2,
        });
    });

    it('tells a presser whose question is not written yet apart from one whose question is gone', async () => {
        // The run id is minted before the row exists, so a press landing in that
        // window finds nothing. Reporting it as "gone" would send somebody
        // looking for a deletion that never happened.
        const notYet = await handleFlowChoiceInteraction(buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0)), {
            flowRunsRepo: { getByRunId: () => Promise.resolve(null) },
            resume: vi.fn() as never,
        });

        const closed = await handleFlowChoiceInteraction(buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0)), {
            flowRunsRepo: { getByRunId: () => Promise.resolve({ ...parkedRun(), status: 'completed' }) },
            resume: vi.fn() as never,
        });

        // Neither promises the other's fix: a missing row may be a question
        // mid-write or one that is gone, and retrying only helps the first. So the
        // two say different things, and neither is the failure copy.
        expect(notYet.message).not.toEqual(closed.message);
        expect(closed.message).toEqual(QUESTION_CLOSED_MESSAGE);
        expect([notYet.status, closed.status]).toEqual(['skipped', 'skipped']);
    });

    it('does not let one member answer a question put to another', async () => {
        const resume = vi.fn();
        const somebodyElse: FlowRunEntity = {
            ...parkedRun(),
            contextSnapshot: { guildId: GUILD_ID, userId: 'somebody-else' },
        };

        const result = await handleFlowChoiceInteraction(buttonInteraction(buildFlowChoiceCustomId(RUN_ID, NODE_ID, 0)), {
            flowRunsRepo: { getByRunId: () => Promise.resolve(somebodyElse) },
            resume: resume as never,
        });

        expect(result.status).toBe('error');
        expect(resume).not.toHaveBeenCalled();
    });
});

describe('the prompt block', () => {
    it('leaves by the handle matching the answer, and by timeout when nobody answers', async () => {
        const config = { question: 'Well?', choices: ['Yes', 'No', 'Maybe'] };

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
        const shrunk = { question: 'Well?', choices: ['Yes'] };

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
        const send = vi.fn().mockResolvedValue(undefined);

        const outcome = await promptBlock.run(
            { question: 'Well?', choices: ['Yes', 'No'] },
            { ...runContext(), channel: { send } as unknown as FlowRunContext['channel'] }
        );

        expect(outcome).toEqual({ kind: 'suspend', suspension: { wakeAt: undefined } });
        const posted = send.mock.calls[0]?.[0] as { components: [{ components: { data: { label: string } }[] }] };
        expect(posted.components[0].components.map((button) => button.data.label)).toEqual(['Yes', 'No']);
    });
});

/** A run parked at the prompt node, as the dispatcher would read it back. */
function parkedRun(): FlowRunEntity {
    return {
        runId: RUN_ID,
        guildId: GUILD_ID,
        status: 'suspended',
        resumeNodeId: NODE_ID,
        contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
    } as unknown as FlowRunEntity;
}

function buttonInteraction(customId: string): ButtonInteraction {
    return {
        customId,
        isButton: () => true,
        deferred: true,
        replied: false,
        guild: { id: GUILD_ID },
        user: { id: USER_ID },
        client: {} as Client,
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
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
