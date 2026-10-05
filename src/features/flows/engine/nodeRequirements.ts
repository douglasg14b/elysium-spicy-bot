import {
    effectiveFieldValue,
    isFieldVisible,
    type BlockConfigField,
    type BlockManifest,
    type FlowContextRequirement,
} from '../blocks/manifest';
import type { FlowRunSeed } from '../blocks/types';
import { tokenRequirement, tokensIn, visibleCopyStrings, type RunLeg } from './copyRendering';

export type { RunLeg } from './copyRendering';

/**
 * What one node needs from the run — worked out once, for save-time validation and the
 * executor alike.
 *
 * A node's **effective requirements** come from three declarations, and no list of
 * blocks anywhere:
 *
 * 1. its block's `requires`;
 * 2. the `requires` of the option picked in each visible `select` or `segmented` field —
 *    Time Since's "the member's last message" needs a member, its channel source does not;
 * 3. the requirement of each built-in token in its visible copy, `objectList` columns
 *    included — `{{subject.mention}}` needs a member, `{{guild.name}}` nothing.
 *
 * One function, so the validator that refuses a graph and the executor that refuses a
 * step cannot come to disagree about what a node needs. A trigger's `requires` reads the
 * other way round — what it supplies — so callers skip triggers; this does not decide
 * that for them.
 */

/** Why a node needs a requirement: its block, a picked option, or a token in its copy. */
export type RequirementCause =
    | { readonly kind: 'block' }
    | {
          readonly kind: 'option';
          readonly field: BlockConfigField;
          /** The picked option's label, as the author sees it in the control. */
          readonly optionLabel: string;
      }
    | {
          readonly kind: 'token';
          readonly field: BlockConfigField;
          readonly token: string;
          /** Where the copy is, as `visibleCopyStrings` words it. */
          readonly where: string;
      };

/** One requirement a node has, with the first declaration that gave it one. */
export interface NodeRequirement {
    readonly requirement: FlowContextRequirement;
    readonly cause: RequirementCause;
}

/**
 * Every requirement one node has, each once, with what caused it.
 *
 * Read off the node's stored data: a field its `visibleWhen` hides does not apply, and an
 * unset choice counts as its declared default — so a Time Since dropped untouched needs a
 * member, because its default source is the member's last message.
 *
 * Each requirement is reported once, by the first thing that asks for it — the block,
 * then options in field order, then tokens in field order — so a node using
 * `{{subject.mention}}` twice is one finding, not two.
 */
export function effectiveRequirements(
    block: Pick<BlockManifest, 'requires' | 'configFields'>,
    nodeData: Readonly<Record<string, unknown>>
): readonly NodeRequirement[] {
    const found = new Map<FlowContextRequirement, RequirementCause>();
    const add = (requirement: FlowContextRequirement, cause: RequirementCause): void => {
        if (!found.has(requirement)) {
            found.set(requirement, cause);
        }
    };

    for (const requirement of block.requires) {
        add(requirement, { kind: 'block' });
    }

    for (const field of block.configFields) {
        if ((field.control !== 'select' && field.control !== 'segmented') || !isFieldVisible(field, block.configFields, nodeData)) {
            continue;
        }
        const value = effectiveFieldValue(field, nodeData);
        const option = field.options.find((candidate) => candidate.value === value);
        if (!option) {
            continue;
        }
        for (const requirement of option.requires ?? []) {
            add(requirement, { kind: 'option', field, optionLabel: option.label });
        }
    }

    for (const copy of visibleCopyStrings(block.configFields, nodeData)) {
        for (const token of tokensIn(copy.value)) {
            const requirement = tokenRequirement(token);
            if (requirement) {
                add(requirement, { kind: 'token', field: copy.field, token, where: copy.where });
            }
        }
    }

    return [...found].map(([requirement, cause]) => ({ requirement, cause }));
}

/**
 * The cause as a phrase continuing "needs X from the run", or nothing for the block's
 * own requirement — which reads exactly as it always has.
 */
export function describeRequirementCause(cause: RequirementCause): string {
    switch (cause.kind) {
        case 'block':
            return '';
        case 'option':
            return ` for "${cause.field.label}" set to "${cause.optionLabel}"`;
        case 'token':
            return ` for {{${cause.token}}} in ${cause.where}`;
        default: {
            const illegal: never = cause;
            throw new Error(`Unknown requirement cause ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * How the executor asks a run whether it carries a requirement, or `null` for one it
 * leaves to the block.
 *
 * Keyed by requirement, so a new member of the vocabulary is a compile error here until
 * somebody decides what it means at run time.
 *
 * **`channel` is the block's to answer, not the executor's.** A channel can disappear
 * between a park and its wake — deleted, or walled off — and the resume path then hands
 * the run on as nowhere, deliberately (`rebuildResumeContext`): a run whose remaining
 * steps are a DM and a role should not fail because the room it parked in is gone. So
 * `condition.inChannel` answers "no", and Ask a Question fails by its own name. Save-time
 * validation still refuses a path that could never have had one.
 */
const RUN_CHECKS: Readonly<Record<FlowContextRequirement, ((context: FlowRunSeed) => boolean) | null>> = {
    subject: (context) => context.subject !== undefined,
    actor: (context) => context.actor !== undefined,
    interaction: (context) => context.interaction !== undefined,
    channel: null,
};

/**
 * The first requirement a node has that this run does not carry, or undefined when it
 * can run.
 *
 * The executor's check before every non-trigger block's `run`. Save-time validation
 * keeps a live graph from reaching one, so a miss here means a graph saved before a
 * rule existed, or an incomplete one a parked run resumed into — and failing the step by
 * name beats a block finding nothing where it expected a member.
 */
export function missingRequirement(
    block: Pick<BlockManifest, 'requires' | 'configFields'>,
    nodeData: Readonly<Record<string, unknown>>,
    context: FlowRunSeed
): NodeRequirement | undefined {
    return effectiveRequirements(block, nodeData).find(({ requirement }) => {
        const check = RUN_CHECKS[requirement];
        return check !== null && !check(context);
    });
}

/**
 * A requirement in the executor's words: what the node needs, and why this run has none —
 * the two halves of its failure, with the cause between them.
 */
function describeAbsent(
    requirement: FlowContextRequirement,
    leg: RunLeg
): { readonly wanted: string; readonly absent: string } {
    switch (requirement) {
        case 'subject':
            return { wanted: 'a member', absent: 'this run is about nobody' };
        case 'actor':
            return {
                wanted: 'whoever caused this step',
                absent:
                    leg === 'resumed'
                        ? 'nobody did — this run was woken after a wait, with nobody acting on it'
                        : "nobody did — this run's trigger doesn't say who caused it",
            };
        case 'interaction':
            return { wanted: 'the interaction that started the run', absent: 'this run has none' };
        case 'channel':
            return { wanted: 'a channel', absent: 'this run is not in one' };
        default: {
            const illegal: never = requirement;
            throw new Error(`Unknown requirement ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * The executor's failure for a node reached without a requirement, naming the node and
 * what caused it: `Node x (action.assignRole) needs a member, and this run is about
 * nobody.`, or with an option or token between the halves.
 */
export function describeMissingRequirement(
    nodeId: string,
    nodeType: string,
    missing: NodeRequirement,
    leg: RunLeg
): string {
    const { wanted, absent } = describeAbsent(missing.requirement, leg);
    return `Node ${nodeId} (${nodeType}) needs ${wanted}${describeRequirementCause(missing.cause)}, and ${absent}.`;
}
