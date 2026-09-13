import type { ButtonInteraction, Client, Guild, GuildMember, User } from 'discord.js';

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
 * its `wakeAt` came due first. A plain time delay only ever sees `timeout`.
 */
export const FLOW_RESUME_REASONS = ['event', 'timeout'] as const;

export type FlowResumeReason = (typeof FLOW_RESUME_REASONS)[number];

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
 * Runtime context threaded through a single flow execution. Actions call
 * discord.js directly via these handles.
 */
export interface FlowRunContext {
    client: Client;
    guild: Guild;
    /** The member who triggered the flow (present for button/member triggers). */
    member: GuildMember;
    /** Convenience alias for `member.user`. */
    user: User;
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

