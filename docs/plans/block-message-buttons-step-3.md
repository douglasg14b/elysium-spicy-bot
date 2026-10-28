# A block can act on whoever acted, not only on who the run is about (step 3)

> **Status**: Planned 2026-10-27; Douglas: "that matches — start building", then "continue building until completely done". Built 2026-10-27, uncommitted — see "As built". Not run live.
> **Owner**: Douglas
> **Follows**: [block-message-buttons-step-2.md](block-message-buttons-step-2.md), committed in `e92c17a`.

## The gap

Every run carries two people: who it is **about** (`context.subject`) and who **acted** (`context.actor`). Copy can name both (`{{subject.mention}}`, `{{actor.mention}}`), and the trigger's gate can pick either. But every block that does something to a member reads `requireSubject(context)`, so a flow can't, say, give the mod who pressed "Approve" a role, or DM the mod who claimed a ticket.

Step 2 made this matter: a press on a ticket's button runs about the ticket's subject with the presser as actor. Ticket Event already had a mod as actor.

## What step 3 does

A **"Who"** field on each block that acts on or asks about one member, with two choices:

| Value | Label | Needs |
|---|---|---|
| `subject` (default) | The member this run is about | `subject` |
| `actor` | Whoever set this off | `actor` |

- The default is `subject`, so every saved graph means what it meant: an unset choice counts as its declared default (`effectiveRequirements`).
- The block's own `requires: ['subject']` moves onto the option (`BlockSelectOption.requires`, the Time Since precedent), so picking "Whoever set this off" needs an actor instead. A trigger with no actor (Schedule, Member Leaves) refuses it at save with the existing requirement sentence, and the builder greys the option (`requirementAvailableAt`).
- One shared definition — the field, its schema piece and the reader `memberFor(context, choice)` — in `src/features/flows/blocks/` (beside `requireSubject` in `types.ts`, or its own small file), so ten blocks don't repeat it. The reader fails by name like `requireSubject` when the chosen person is missing (only reachable if the save check regressed).
- The card summary names the choice only when it isn't the default ("· whoever set this off"); the default adds nothing to the card.

## Blocks

In: Assign Role, Remove Role, Award XP, Kick Member, Send DM, Has Role, Is Booster, Level At Least, Has Open Ticket, Time Since (its member sources only — the field is shown by `visibleWhen` on those sources, so its option's requirement doesn't apply to a channel source).

Out, on purpose:
- **Open Ticket** — the ticket is about the run's member; who it's for is a ticket decision, not this field.
- **Ask a Question** — answerable only by the member whose run it is (its own ownership rule).
- **Wait for Event** — waits on the run's member's events.

## Decisions

1. **Field key `member`**, values `subject` / `actor` — the engine's own words, already allowed by the vocabulary gate. Check `engineVocabulary.test.ts` and the block field-rule export; if `member` collides with anything, pick the nearest neutral word and say so.
2. **A person who has left** is a partial member, for the actor exactly as for the subject; blocks that need a full member already fail by name (Kick's `fetchIfStillHere`, role blocks).
3. **The actor can be the bot** (a flow block's ticket change names the bot as actor). Acting on it is what the author picked; no special case.
4. **No migration.** Absent means `subject`.

## Tests

- `effectiveRequirements`: an unset or `subject` choice needs `subject`; `actor` needs `actor` and not `subject`.
- Save refuses "Whoever set this off" under a Schedule trigger, by name.
- Per block (a table test is fine): the chosen person is the one acted on — Assign Role gives the actor the role and leaves the subject alone; Has Role reads the actor's roles; Award XP credits the actor.
- Existing tests unchanged with the default.
- A block-type-free check that every in-scope block declares the field (or conformance-level, whichever is smaller).
- Builder: the option is greyed where no actor is available; the card shows the choice only when non-default.
- Sabotage: make the reader ignore the choice → the actor test fails.

## As built

- **Shared definition**: `src/features/flows/blocks/memberChoice.ts` — `MEMBER_CHOICES`, `memberChoiceSchema` (`z.enum(['subject','actor']).default('subject')`), `MEMBER_CHOICE_FIELD` (key `member`, label "Who", a `select`; options "The member this run is about" `requires: ['subject']` and "Whoever set this off" `requires: ['actor']`), `MEMBER_CHOICE_CARD_PART` (shown by its own field while it holds `actor`) and `memberFor(context, choice)`, which throws by name as `requireSubject` does. Its own file rather than `types.ts`, since it carries a zod piece and a field declaration. `member` collided with nothing (vocabulary gate, field-rule export).
- **The ten blocks** declare the field, the card part and `requires: []`, and read their person through `memberFor`. Time Since spreads the field with `visibleWhen` on its two member sources, and those source options no longer carry `requires: ['subject']` — the shown choice does.
- **Card**: reads "Assign @Mod · Whoever set this off" — the option's own label, capital W, not the plan's lowercase "· whoever set this off": the card renders option labels, and a card-only label for one letter would be new vocabulary.
- **Conformance** (deviation, small): a card part may now be shown by **its own** field even where that field is itself conditional (`checkVisibleWhenSource`'s `ownKey`). Needed for Time Since, whose member choice is conditional; safe because the card drops a part whose field is hidden before reading the part's `visibleWhen`, so there is no chain. A part shown by another conditional field is still refused.
- **Palette** (not in the plan): moving `subject` off the blocks would have stopped the palette greying them on a flow whose runs are all about nobody. `NodePalette`'s rule now also greys a block with an always-shown choice whose every option needs a member (`subject` or `actor`); a choice the block can hide (Time Since) still leaves it open.
- **Wording change**: an untouched block below a trigger about nobody now fails, at save and at run, as `needs a member for "Who" set to "The member this run is about"` rather than plain `needs a member`, and its save issue sits under the Who field rather than at node level. Existing tests asserting the old sentence were updated to it; tests calling a block's `run` directly now pass `member: 'subject'`.
- **Time Since's member sources relabelled** "Their last message" and "When they joined" (were "The member's last message" / "When the member joined"), so the source does not contradict a Who set to whoever set this off. Labels only: stored values unchanged.
- **Not done, on purpose** (decision 3, the bot as actor): a Send DM to the bot fails with Discord's raw 50007, and Award XP to the bot gives it XP and a public level-up. Both are what the author picked; failing them by name is a follow-up if it bites.
- **No migration**, as planned.
- **Tests**: `blocks/__tests__/memberChoice.test.ts` (every block × unset/subject/actor touches only the chosen person; requirements; `memberFor`; a source scan holding every block that reads a member to either the shared field or a block-level `subject`), `subjectAbsentRuns.test.ts` (Schedule refuses "Whoever set this off" under the Who field; the executor fails it by cause), conformance cases for the self-shown part, `oneDirectoryBlock.test.ts` (Is Booster's real card names the choice only when non-default), and the builder's `cardSummary.test.ts` and `subjectAvailability.test.tsx` (palette greys; the inspector disables the actor option after a park and the member option where a run about nobody arrives).
