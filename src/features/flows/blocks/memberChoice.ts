import type { GuildMember, PartialGuildMember } from 'discord.js';
import { z } from 'zod';
import type { BlockCardSummaryPart, BlockConfigField } from './manifest';
import { requireSubject, type FlowRunSeed } from './types';

/**
 * Which of a run's two people a block acts on or asks about: the member the run is
 * **about** (`subject`) or whoever **set this step off** (`actor`).
 *
 * The engine's own words for the two halves of the member split, so a stored value says
 * exactly what `FlowRunSeed` calls the person it picks. `subject` first: it is the
 * default, and every graph saved before the choice existed means it — an unset choice
 * reads as its declared default everywhere (`effectiveFieldValue`), so no migration.
 */
export const MEMBER_CHOICES = ['subject', 'actor'] as const;

export type MemberChoice = (typeof MEMBER_CHOICES)[number];

/**
 * The choice's piece of a block's config schema, under the key {@link MEMBER_CHOICE_FIELD}
 * edits. Defaulted, so a node saved before the field existed parses as `subject`; and
 * optional for that reason too, so a block may hide it with `visibleWhen` (Time Since's
 * channel sources, which ask about nobody).
 */
export const memberChoiceSchema = z.enum(MEMBER_CHOICES).default('subject');

/**
 * The "Who" field, shared by every block that acts on or asks about one member.
 *
 * The block's own `requires` no longer says `subject`; each option says what *it* needs,
 * so picking "Whoever set this off" needs an actor instead — refused at save below a
 * trigger that names nobody acting (Schedule, Member Leaves) or after a block that parks,
 * and greyed in the builder there. One declaration, so ten blocks cannot come to word or
 * require it differently.
 */
export const MEMBER_CHOICE_FIELD = {
    key: 'member',
    label: 'Who',
    description:
        'The member this run is about, or whoever set this off — the mod who pressed the button or claimed the ' +
        "ticket. Not after a wait: once the clock wakes the run, nobody set it off, and the clock doesn't count.",
    control: 'select',
    defaultValue: 'subject',
    options: [
        { value: 'subject', label: 'The member this run is about', requires: ['subject'] },
        { value: 'actor', label: 'Whoever set this off', requires: ['actor'] },
    ],
} as const satisfies BlockConfigField;

/**
 * The card part naming the choice, shown only while it is not the default: an untouched
 * node means what it always meant, and a marker on every card would say nothing.
 *
 * Shown by its own field. Conformance allows that even where the field is itself
 * conditional (Time Since), since a part whose field is hidden renders nothing anyway.
 */
export const MEMBER_CHOICE_CARD_PART = {
    key: MEMBER_CHOICE_FIELD.key,
    prefix: ' · ',
    visibleWhen: { field: MEMBER_CHOICE_FIELD.key, equals: ['actor'] },
} as const satisfies BlockCardSummaryPart;

/**
 * The member a block's choice picks.
 *
 * The executor has already compared the node's requirements with the run — the picked
 * option's `requires` among them — so for a node whose field holds this choice this never
 * throws. It throws a named programming error, as {@link requireSubject} does, because
 * reaching it without the person means that check regressed, and a `!` would turn that
 * into a null dereference deep inside discord.js.
 *
 * **Either may be a member who has already left**, a partial one when the bot never
 * cached them; a block needing a full member fails by its own name (Kick Member fetches
 * them fresh). **The actor may be the bot itself**, when a flow's own ticket change set
 * this run off — acting on it is what the author picked.
 */
export function memberFor(context: FlowRunSeed, choice: MemberChoice): GuildMember | PartialGuildMember {
    switch (choice) {
        case 'subject':
            return requireSubject(context);
        case 'actor': {
            const { actor } = context;
            if (!actor) {
                throw new Error(
                    'This block is set to act on whoever set this off, and nobody did on this run. The executor ' +
                        'should have refused to run it — the requirement check has regressed.'
                );
            }
            return actor;
        }
        default: {
            const illegal: never = choice;
            throw new Error(`Unknown member choice ${JSON.stringify(illegal)}.`);
        }
    }
}
