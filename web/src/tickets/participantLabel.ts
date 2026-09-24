import type { TicketParticipant } from '../api/types';

/**
 * How a person on a ticket is written on screen.
 *
 * Three states, because the snapshot columns have three:
 *
 *  - **both names** → `Kitten (@someuser)`. The nickname is what the guild calls them
 *    and the handle is what they are; an operator cross-referencing Discord needs both.
 *  - **username only** → `someuser`. No nickname set, or they have left the guild.
 *  - **neither** → the raw id, because a row written before the snapshot columns
 *    existed recorded no names. Null means "not recorded", not "has no name" — so
 *    inventing `Unknown User` would put a string here that no consumer could
 *    distinguish from somebody's actual username.
 *
 * `nickname` equal to `username` still renders the pair rather than collapsing it: the
 * snapshot stores `member.nickname`, not `displayName`, precisely so "no nickname" and
 * "nickname matching the handle" stay different facts — and a nickname somebody
 * deliberately set to their handle is a fact about the guild, not a duplicate.
 */
export function participantLabel(participant: TicketParticipant): string {
    if (participant.nickname && participant.username) {
        return `${participant.nickname} (@${participant.username})`;
    }

    // `||` rather than `??`: an empty-string username is as unusable as a null one, and
    // rendering a blank cell would look like a layout bug rather than a missing snapshot.
    return participant.username || participant.id;
}

/**
 * The same, for a slot a ticket may legitimately not have.
 *
 * A flow-opened ticket has no opener and an unclaimed one has no claimer. Said plainly
 * rather than rendered as an empty mention or a dash nobody can interpret.
 */
export function optionalParticipantLabel(
    participant: TicketParticipant | null,
    absent: string
): string {
    return participant ? participantLabel(participant) : absent;
}
