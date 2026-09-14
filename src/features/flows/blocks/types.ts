import type { ButtonInteraction, Client, Guild, GuildMember, GuildTextBasedChannel } from 'discord.js';

/**
 * Why a parked run is being woken, as seen by the block that parked it.
 *
 * A block that suspends is re-entered at its own node when the run wakes, so it
 * needs to know which of the things it was waiting for actually happened. The
 * executor supplies this and reads nothing else about it: the block maps the
 * reason to one of its own declared handles, which is what lets the executor
 * resume a suspending block without knowing which block it is.
 *
 * `event` means the gateway event the block asked for arrived; `timeout` means
 * its `wakeAt` came due first; `choice` means a person picked one of the options
 * the block offered. A plain time delay only ever sees `timeout`.
 *
 * A variant rather than a string union because `choice` carries which option was
 * picked and the other two carry nothing. A block reads `kind` first; only a
 * block that offered choices ever looks at `index`.
 *
 * These name what happened *outside* the run, which is why this can grow where
 * the interpreter's own frozen enums (`FLOW_RUN_STATUSES`,
 * `FLOW_STEP_OUTCOME_KINDS`) must not: a new external cause is a real new thing
 * in the world, not interpreter creep.
 */
export type FlowResumeReason =
    | { readonly kind: 'event' }
    | { readonly kind: 'timeout' }
    | {
          readonly kind: 'choice';
          /**
           * Which of the block's declared choices was taken, by position.
           *
           * A position rather than an author-chosen key because this has to
           * survive a round trip through a Discord `custom_id`, which is capped
           * at 100 characters. A run id and a node id are each up to 36, so by
           * the time a prefix and separators are counted there are about 20
           * left — enough for a short label and not enough for a guarantee. A
           * position always fits, and the label the author wrote stays where it
           * is useful, on the button.
           */
          readonly index: number;
      };

/**
 * The kinds of thing that can wake a parked run.
 *
 * Derived from {@link FlowResumeReason} rather than declared beside it. The two
 * were hand-written separately at first, which left the more likely drift
 * uncaught: adding a variant to the union without adding its name here. Deriving
 * makes that impossible instead of guarded.
 */
export type FlowResumeKind = FlowResumeReason['kind'];

/** A run woken by the gateway event its block asked for. */
export const RESUME_EVENT = { kind: 'event' } as const satisfies FlowResumeReason;

/** A run woken by its own `wakeAt` coming due. */
export const RESUME_TIMEOUT = { kind: 'timeout' } as const satisfies FlowResumeReason;

/**
 * The run is waking, and this is the node that parked it.
 *
 * Addressed to a node rather than merely "the first node of the segment": a run
 * parked by an older build resumes at the node *after* a delay, which never
 * parked and must run forward normally. Naming the node makes that exemption
 * structural instead of something the executor has to reason about.
 */
export interface FlowResume {
    /** The node whose `run` returned the suspension. */
    readonly nodeId: string;
    readonly reason: FlowResumeReason;
}

/**
 * A value one block leaves for later blocks to read.
 *
 * Scalar only, and deliberately so: a run variable holds an id or a reference,
 * never evidence. Making it structurally awkward to stash a message body or an
 * attachment url is the point — a bag that can hold anything becomes the place
 * every feature hides its state, and none of it survives a schema change.
 */
export type FlowVariableValue = string | number | boolean | null;

/**
 * The facts about a run that its *caller* establishes — everything a block sees
 * except the write channel.
 *
 * Separate from {@link FlowRunContext} because a dispatcher genuinely cannot
 * supply a {@link FlowRunContext.setOutput}: a write channel belongs to one node
 * of one segment, and only the executor knows which node is running. Asking a
 * caller for one would mean every dispatcher inventing a writer that discards
 * what it is given — a no-op that silently loses values, which is precisely the
 * failure the cap and the drain exist to make impossible.
 *
 * So a caller describes the run, and the executor closes the loop per node.
 */
export interface FlowRunSeed {
    client: Client;
    guild: Guild;
    /**
     * The member the run is *about*. Always present.
     *
     * Distinct from {@link actor} because the two genuinely diverge: a moderator
     * advancing someone else's run acts on a subject who is not themselves. Every
     * block that asks "whose roles, whose DM, whose boost status" means this one.
     */
    subject: GuildMember;
    /**
     * The member who caused the *current step*, when a member caused it at all.
     *
     * Absent when the clock woke the run rather than a person — a resumed run has
     * no actor, because nobody acted. Reporting the subject here instead would be
     * a convenient lie, and the whole reason the two are separate fields.
     */
    actor?: GuildMember;
    /**
     * Where the run is operating, when a step has established somewhere.
     *
     * Absent on a run started by a gateway event, which happens nowhere in
     * particular. A block that posts "here" reads this rather than asking the
     * author to pick a channel it already knows.
     */
    channel?: GuildTextBasedChannel;
    /**
     * Named values earlier blocks produced, keyed by the output keys those blocks
     * declared.
     *
     * Read-only to a block: a block writes through {@link setOutput} rather than
     * by mutating this, so the executor stays the only thing that decides what a
     * downstream node can see. Non-optional and empty by default — making it
     * optional would force `context.variables?.[key]` at every read site forever,
     * to describe a state that never occurs.
     *
     * Keys are **flat and author-declared**: the executor does not qualify them
     * by node id. A namespaced store and the flat `{{var.<name>}}` token cannot
     * both be true — a dotted key would leave `{{var.welcomeMessage}}` with no
     * defined resolution, and every tie-break is bad (last-writer-wins
     * reintroduces the collision, error-on-ambiguity breaks an author's copy the
     * moment they add a second producer, and writing node ids into copy is
     * unusable). Collision is a save-time concern instead.
     */
    variables: Readonly<Record<string, FlowVariableValue>>;
    /** The originating interaction, when the trigger was an interaction. */
    interaction?: ButtonInteraction;
    /**
     * Why you are waking, set only on the node that actually parked this run.
     *
     * Absent on a fresh run, and absent for every other node in a resumed
     * segment, so a block can never mistake "this run resumed earlier" for "I am
     * being resumed now". A block that parks **must** check this first: return a
     * suspension again without looking and the run parks forever.
     */
    resume?: FlowResumeReason;
}

/**
 * Runtime context threaded through a single flow execution. Actions call
 * discord.js directly via these handles.
 *
 * Everything a caller establishes about the run comes from {@link FlowRunSeed};
 * what this adds is the one thing only the executor can give, which is somewhere
 * for this node's values to go.
 */
export interface FlowRunContext extends FlowRunSeed {
    /**
     * This run's durable id, and the id of the node currently running.
     *
     * Together they address **this member's run at this node**, which is what a
     * block needs to post a component a press can route back to. A flow id and a
     * node id are not enough: two members can be parked at the same node of the
     * same flow at once, and a button naming only the graph would advance
     * whichever run the engine found first.
     *
     * `runId` is minted when the run starts rather than when it parks, so it is
     * available here on the first leg — before any row exists. That ordering is
     * deliberate and has one consequence worth knowing: a component posted during
     * `run` names a row that is written moments later, when the executor persists
     * the suspension. A press landing inside that window finds no run, which the
     * dispatcher reports as a question that is not ready rather than as a
     * question that is gone.
     *
     * Present on every run, parking or not — a block that never parks simply has
     * no use for them.
     */
    readonly runId: string;
    readonly nodeId: string;
    /**
     * Record a value for later blocks to read, under a key this block declared.
     *
     * A method rather than a slot on the step outcome because a suspending block
     * must be able to write on its *resume* leg, when it is returning `continue`
     * rather than `suspend` — a second outputs slot on the `suspend` arm could
     * never carry that, and growing the outcome union is not on the table.
     *
     * Writing the same key twice within one node overwrites; the last write wins,
     * which is the only reading that makes a retried step idempotent. Values land
     * in {@link variables} once the node returns, so a block cannot read back what
     * it just wrote — it already has the value, and a node that could see its own
     * writes would make "what this node was handed" depend on where in `run` you
     * looked.
     *
     * The bag is size-capped, and exceeding the cap fails the run naming the keys
     * rather than silently dropping one.
     */
    setOutput(key: string, value: FlowVariableValue): void;
}

