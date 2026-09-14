import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { z } from 'zod';
import { DISCORD_BUTTON_LABEL_MAX_LENGTH, FLOW_MAX_CHOICES, FLOW_MAX_DELAY_MS } from '../../constants';
import {
    eligibilityConfigSchema,
    ELIGIBILITY_CONFIG_KEY,
    OPEN_GATE,
} from '../../engine/eligibility';
import type { FlowStepOutcome } from '../../engine/stepOutcome';
import { buildFlowChoiceCustomId } from '../../utils/customId';
import type { BlockManifest } from '../manifest';
import type { FlowResumeReason } from '../types';

export const ACTION_PROMPT = 'action.prompt';

/** Output handle followed when nobody answers before `timeoutMs` elapses. */
export const PROMPT_TIMEOUT_HANDLE = 'timeout';

/**
 * The handle a run leaves by when choice `index` is picked.
 *
 * Positional, matching {@link FlowResumeReason}'s `choice` variant, and declared
 * as a fixed set of five rather than derived from the author's list. Handles are
 * served to the browser as plain JSON, so a manifest cannot compute them per
 * node — a function member would be typed as present on the descriptor and
 * serialise to nothing. Five static handles is the honest form of that
 * constraint; see `docs/prds/flow-engine-v2-build-order.md`, slice B2.
 */
export function promptChoiceHandle(index: number): string {
    return `choice-${index}`;
}

export const promptConfigSchema = z.object({
    question: z.string().min(1).max(2000),
    choices: z
        .array(z.string().min(1).max(DISCORD_BUTTON_LABEL_MAX_LENGTH))
        .min(1)
        .max(FLOW_MAX_CHOICES),
    timeoutMs: z.number().int().positive().max(FLOW_MAX_DELAY_MS).optional(),
    /*
     * Who may answer, **narrowing** the dispatcher's own rule that a question is
     * answerable only by the member whose run it is.
     *
     * It can only narrow, never widen: the ownership check runs first and is not
     * authorable, because a run belongs to one member and a button naming that
     * run is not an invitation to anybody else. So this is for the author who
     * wants "and only if they still hold the verified role" — a second condition
     * on the same person, not a way to let a different one answer.
     *
     * Letting a moderator answer somebody else's question is a real thing to want
     * and is deliberately **not** this. It needs the ownership rule to become
     * authorable rather than absolute, which changes what a `flowc:` button means
     * and is not in this slice.
     */
    [ELIGIBILITY_CONFIG_KEY]: eligibilityConfigSchema,
});

export type PromptConfig = z.infer<typeof promptConfigSchema>;

/**
 * Ask the member a question and hold the run until they answer.
 *
 * An embed with buttons, and events off those buttons. The question is posted on
 * the parking leg; the press routes back through the `flowc:` dispatcher, which
 * resumes this run with the index that was pressed, and this block turns that
 * into one of its own handles.
 *
 * **It parks with no `waitKind`, deliberately.** `findWaiting` selects on
 * `waitKind is not null`, so a prompt is never a candidate row for
 * `resumeWaitingRunsForEvent` — a member clicking some unrelated flow button
 * cannot answer a question they were never shown, and this block never has to
 * guard against it. The invisibility is structural, not a check.
 *
 * `timeoutMs` is the other half of that: with no event fan-out to wake it, a
 * prompt nobody answers is otherwise parked forever. The block still allows it —
 * an unanswered question that simply waits is a legitimate design — but the
 * timeout handle is how an author says what happens when a member walks away.
 */
export const block: BlockManifest<PromptConfig> = {
    type: ACTION_PROMPT,
    kind: 'action',
    label: 'Ask a Question',
    description: 'Put a question to them with buttons, and take a different path depending on the answer.',
    group: 'actions',
    icon: '❓',
    configSchema: promptConfigSchema,
    configFields: [
        {
            key: 'question',
            label: 'Question',
            description: 'Shown in the embed above the buttons.',
            control: 'longText',
            placeholder: 'So, are you in?',
            maxLength: 2000,
            rendersTokens: true,
        },
        {
            key: 'choices',
            label: 'Answers',
            description: `One button each, in order. Up to ${FLOW_MAX_CHOICES} — Discord's limit for a single row.`,
            control: 'textList',
            placeholder: 'Yes, obviously',
            maxLength: DISCORD_BUTTON_LABEL_MAX_LENGTH,
            minEntries: 1,
            maxEntries: FLOW_MAX_CHOICES,
            addLabel: 'Add an answer',
            defaultValue: ['Yes', 'No'],
        },
        {
            key: 'timeoutMs',
            label: 'Give up after',
            description:
                'Leave empty to wait indefinitely. Otherwise an unanswered question leaves by the Timed out handle — wire it up, or the run fails.',
            control: 'duration',
            optional: true,
            placeholder: 'No limit',
        },
        {
            key: ELIGIBILITY_CONFIG_KEY,
            label: 'Who can answer',
            description:
                'Only the person this run is about can answer, always. This narrows it further — anybody else is told quietly and the question stays open.',
            control: 'eligibility',
            defaultValue: OPEN_GATE,
        },
    ],
    cardSummary: [
        { key: 'question', quote: true, truncate: 28, emptyText: 'no question yet', stopIfEmpty: true },
        { key: 'choices', prefix: ' · ', hideWhenEmpty: true },
        { key: ELIGIBILITY_CONFIG_KEY, prefix: ' · 🔒 ', hideWhenEmpty: true },
    ],
    /**
     * Five choice handles plus a timeout, always — an author offering two answers
     * sees three unwired handles below them. Known debt, recorded in the build
     * order: the fix is a manifest member naming the config field that governs
     * how many handles show, not a special case for this block type in the
     * builder.
     */
    handles: [
        { id: promptChoiceHandle(0), label: 'Answer 1', tone: 'neutral' },
        { id: promptChoiceHandle(1), label: 'Answer 2', tone: 'neutral' },
        { id: promptChoiceHandle(2), label: 'Answer 3', tone: 'neutral' },
        { id: promptChoiceHandle(3), label: 'Answer 4', tone: 'neutral' },
        { id: promptChoiceHandle(4), label: 'Answer 5', tone: 'neutral' },
        { id: PROMPT_TIMEOUT_HANDLE, label: 'Timed out', tone: 'caution' },
    ],
    outputs: [],
    // The question is posted where the run is operating, so a run that is nowhere
    // has nowhere to ask. Declared, so save-time validation says so on the canvas
    // rather than letting the run fail in front of a member.
    requires: ['channel'],
    capabilities: ['sendMessages', 'embedLinks'],
    canSuspend: true,
    async run(config, context) {
        if (context.resume) {
            return resumeOutcome(config, context.resume);
        }

        const { channel } = context;
        if (!channel) {
            // `requires: ['channel']` makes this unreachable from a graph the
            // validator accepted. Reported rather than assumed away, because the
            // alternative is a `!` that turns a validator regression into a
            // confusing null dereference deep in discord.js.
            return { kind: 'fail', error: 'This question has nowhere to be asked — the run is not in a channel.' };
        }

        // The schema bounds each label and the number of them, but nothing bounds
        // the composed `flowc:<runId>:<nodeId>:<index>`, which a long hand-written
        // node id can push past Discord's 100. `buildFlowChoiceCustomId` throws
        // rather than truncating — right, because a truncated id names a different
        // node — but a raw throw out of `run` is not this block's way of reporting:
        // every other failure here comes back as `fail`, which the engine records
        // against the node that caused it.
        let buttons: ButtonBuilder[];
        try {
            buttons = config.choices.map((label, index) =>
                new ButtonBuilder()
                    .setCustomId(buildFlowChoiceCustomId(context.runId, context.nodeId, index))
                    .setLabel(label)
                    .setStyle(ButtonStyle.Secondary)
            );
        } catch (error) {
            return {
                kind: 'fail',
                error: error instanceof Error ? error.message : "Could not build this question's buttons.",
            };
        }

        await channel.send({
            embeds: [new EmbedBuilder().setDescription(config.question)],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
            // Matches `action.sendMessage`: the question is authored copy with
            // tokens already expanded, so a member whose display name is
            // `@everyone` must not be able to make it ping the guild.
            allowedMentions: { parse: ['users'] },
        });

        return {
            kind: 'suspend',
            suspension: {
                wakeAt: config.timeoutMs === undefined ? undefined : new Date(Date.now() + config.timeoutMs),
                // No `waitKind`. See the block doc — this is what keeps a prompt
                // out of `findWaiting`'s result set.
            },
        };
    },
};

/** Which handle this block leaves by, given why its run woke. */
function resumeOutcome(config: PromptConfig, resume: FlowResumeReason): FlowStepOutcome {
    switch (resume.kind) {
        case 'timeout':
            return { kind: 'continue', handle: PROMPT_TIMEOUT_HANDLE };
        case 'choice':
            // An index past the author's list means the flow was edited while a
            // member had the question open: the button they are holding names a
            // choice that no longer exists. Failing names that, where continuing
            // by handle would route them down a branch the author deleted.
            if (resume.index >= config.choices.length) {
                return {
                    kind: 'fail',
                    error: `Answer ${resume.index + 1} is no longer one of this question's ${config.choices.length}; the flow changed while it was open.`,
                };
            }
            return { kind: 'continue', handle: promptChoiceHandle(resume.index) };
        case 'event':
            // Nothing can currently send one: a prompt parks with no `waitKind`,
            // so `resumeWaitingRunsForEvent` never sees its row. Named rather
            // than folded in with `choice`, because the one thing this must not
            // do is silently answer the question as though choice 0 were picked.
            return {
                kind: 'fail',
                error: 'This question was woken by an event rather than by an answer, which it cannot interpret.',
            };
    }
}
