/**
 * What a resource row is allowed to say about itself in one line, in one table.
 *
 * Same shape and same reasoning as `RESOURCE_KIND_STYLES` in `resourceMeta.ts`: a
 * chip's tone, glyph, wording and jump target are needed by the summary line, by the
 * detector that decides whether it applies, and by the contract doc that explains it —
 * and three copies drift. Keying one table by the chip id means adding a tenth chip
 * cannot supply a colour and forget where clicking it goes.
 *
 * ## The governing rule
 *
 * A chip earns its place only if it is **(a) not the default**, **(b) not already
 * visible structurally**, and **(c) something you would act on**. Silence means
 * normal. That is the whole design: a row with no chips is a row nobody has to think
 * about, which is precisely what makes the rows that do carry one worth reading.
 *
 * The rejected candidates are as load-bearing as the accepted ones, because each would
 * have appeared on the *majority* of rows — which is the definition of a chip carrying
 * no information. `Creates new` is the default. `Inherits` is the default for anything
 * in a category. `in <category>` is already said by the indentation, `N channels
 * inside` is countable by looking, and `Channel`/`Category`/`Role` is already said by
 * the kind icon and the accent colour. See `docs/contracts/resource-chips.md`, which
 * records the rejections so they are not re-litigated.
 *
 * ## Two tiers, and the line between them
 *
 *  - **info** — true, deliberate, and not the default. Neutral grey, or teal for
 *    adoption, which is the one fact that changes what install *does* to the server.
 *  - **problem** — this will not do what you think. `warn` saves and installs fine and
 *    is probably still wrong; `error` means the save or the install will refuse it.
 *
 * The tier is not decoration. An `error` chip is a claim that the server would reject
 * this declaration, so `detectResourceProblems.ts` mirrors
 * `validateJourneyDeclaration` and the route's Zod schemas rather than approximating
 * them — a red chip that cries wolf costs the whole vocabulary its credibility.
 *
 * ## Every chip is a jump control
 *
 * `jumpTo` names the field that caused the chip, so clicking it expands the row and
 * takes you there. That is what stops these being decoration: each chip is the
 * shortest path to the thing it is complaining about. This table only *names* the
 * target — focus management belongs to whatever renders the expanded row, because only
 * that component owns the refs.
 */

import {
    IconAlertTriangle,
    IconEyeOff,
    IconLink,
    IconLock,
    IconUsers,
    IconX,
    type Icon as TablerIcon,
} from '@tabler/icons-react';

/**
 * How seriously to take a chip.
 *
 * Three values rather than two, because "saves fine but is probably wrong" and "the
 * save will be refused" are genuinely different actions for the reader: the first is
 * worth a look before publishing, the second blocks them right now. Collapsing them
 * into one "problem" tone would make an amber row and a red row equally urgent, and
 * the amber ones are the common case.
 */
export type ResourceChipTone = 'info' | 'warn' | 'error';

/**
 * Which field a chip jumps to when clicked.
 *
 * A closed union rather than a free string, because the renderer switches on it to
 * pick a ref, and an unrecognised target has nothing to focus. `rules` means the
 * permission editor as a whole; `rule` means one numbered row inside it, which is why
 * the chips carrying a rule index are the ones that use it.
 */
export type ResourceChipJumpTarget =
    | 'adoptPicker'
    | 'keyField'
    | 'nameField'
    | 'rules'
    | 'rule';

/** Every chip this vocabulary can show. Adding one means adding it here first. */
export type ResourceChipId =
    | 'adopted'
    | 'private'
    | 'orderedRules'
    | 'nobodyCanSee'
    | 'perRunOnly'
    | 'permissionsUntouched'
    | 'duplicateKey'
    | 'duplicateAdoption'
    | 'invalidKey'
    | 'ruleNamesNoRole';

/**
 * The detail a chip carries, when it has one.
 *
 * Kept as data rather than baked into a pre-formatted label so the caller can use the
 * number for something other than display — the `rule` jump target needs the index to
 * know which row to focus, and a string reading "Rule 2 names no role" has thrown that
 * away. `label` is the only place the two are recombined.
 */
export interface ResourceChipDetail {
    /** How many permission rules this resource has. For `orderedRules`. */
    readonly ruleCount?: number;
    /** Zero-based index of the offending rule. For `ruleNamesNoRole` and `perRunOnly`. */
    readonly ruleIndex?: number;
    /** Which field failed. For `invalidKey`, which covers the key *and* the name. */
    readonly field?: 'key' | 'name';
}

export interface ResourceChipStyle {
    /** Which tier this belongs to, and therefore how loud it is. */
    tone: ResourceChipTone;
    /**
     * Mantine colour key. Derived from the tone in every case but one: `adopted` is
     * teal rather than the neutral grey its `info` tone implies, because adoption is
     * the single fact that changes what install does to the guild and reads as a
     * different *kind* of statement from "this is private".
     */
    color: string;
    /** The glyph this chip is recognised by. */
    icon: TablerIcon;
    /**
     * The wording, given whatever detail the detector found.
     *
     * A function rather than a string because three of the nine carry a number or a
     * field name, and a table holding `label: string` for six entries and
     * `labelFor: (detail) => string` for three would be two shapes for one concept.
     * Chips with nothing to interpolate ignore the argument.
     */
    label: (detail: ResourceChipDetail) => string;
    /**
     * Why this chip appears, in one sentence, for the contract doc and for a tooltip.
     *
     * Written here rather than in the Markdown so the two cannot disagree — the doc's
     * table is checked against this one by `resourceChipsDocSync.test.ts`.
     */
    reason: string;
    /** The field clicking the chip should expand the row and focus. */
    jumpTo: ResourceChipJumpTarget;
}

export const RESOURCE_CHIPS: Record<ResourceChipId, ResourceChipStyle> = {
    adopted: {
        tone: 'info',
        color: 'teal',
        icon: IconLink,
        label: () => 'Adopted',
        reason: 'Install binds an existing channel instead of creating one — the single fact that changes what install does to the server.',
        jumpTo: 'adoptPicker',
    },

    private: {
        tone: 'info',
        color: 'gray',
        icon: IconLock,
        label: () => 'Private',
        reason: 'A rule hides it from @everyone. Worth stating because "who can see this" is the question this modal exists to answer.',
        jumpTo: 'rules',
    },

    /**
     * "in order" is doing real work and is not filler.
     *
     * A bare count — "3 rules" — tells you how much there is to read and nothing about
     * what it means. `compilePermissionIntents` lets a later intent win per-id, so a
     * resource's rules are a **sequence** rather than a set: "hidden from everyone,
     * then read-write for this role" says something its reverse does not. The word is
     * what makes the number actionable at a glance, which is condition (c) of the
     * governing rule; without it this chip would fail its own test for admission.
     */
    orderedRules: {
        tone: 'info',
        color: 'gray',
        icon: IconUsers,
        label: (detail) => `${detail.ruleCount ?? 0} rules in order`,
        reason: 'More than one rule, and none of them a simple hide. Later rules win per id, so these are a sequence rather than a set.',
        jumpTo: 'rules',
    },

    nobodyCanSee: {
        tone: 'warn',
        color: 'yellow',
        icon: IconEyeOff,
        label: () => 'Nobody can see this',
        reason: 'Inheritance is cleared with no rules to replace it. Saves fine, installs fine, and produces a channel only the bot and admins can see.',
        jumpTo: 'rules',
    },

    perRunOnly: {
        tone: 'warn',
        color: 'yellow',
        icon: IconAlertTriangle,
        label: () => 'Per-run only',
        reason: 'A subject audience. `journeyNeedsSubject` makes the whole flow non-installable as shared server structure.',
        jumpTo: 'rule',
    },

    permissionsUntouched: {
        tone: 'warn',
        color: 'yellow',
        icon: IconAlertTriangle,
        label: () => 'Permissions untouched',
        reason: 'Adopted and carrying rules. `applyInstallPlan` only compiles overwrites on the create path, so the rules are saved and never applied.',
        jumpTo: 'rules',
    },

    duplicateKey: {
        tone: 'error',
        color: 'red',
        icon: IconX,
        label: () => 'Duplicate key',
        reason: 'Two resources share a key. `validateJourneyDeclaration` rejects the save outright, and a key must resolve to exactly one binding.',
        jumpTo: 'keyField',
    },

    /**
     * Not in the original nine, and added deliberately.
     *
     * `validateJourneyDeclaration` refuses two resources adopting the same guild
     * object for the same reason it refuses a duplicate key — it is the binding
     * table's uniqueness read backwards, and every later question ("which key owns
     * this channel") would have two answers. It is a save-blocking error the operator
     * can reach from the UI, and an error the vocabulary cannot say is an error the
     * operator meets as an unexplained red banner after pressing save. That is the
     * exact failure `duplicateKey` exists to prevent, one field over.
     *
     * The row's picker already hides an object another row adopts — both
     * `adoptableChannelOptions` and `adoptableRoleOptions` share one claimed-id set
     * for exactly that reason — so this is reachable only by editing an existing
     * row's picker, which is precisely the case nothing else covers.
     */
    duplicateAdoption: {
        tone: 'error',
        color: 'red',
        icon: IconX,
        label: () => 'Adopted twice',
        reason: 'Another resource adopts the same guild object. One guild object cannot be two resources, and `validateJourneyDeclaration` rejects the save.',
        jumpTo: 'adoptPicker',
    },

    /**
     * One chip over two fields, because they are one thought.
     *
     * The key and the name are the two things Zod refuses on a resource, they sit
     * beside each other in the row, and the fix for both is "type something valid
     * here". Splitting them would put two red chips on a row an operator is going to
     * open once anyway. The wording still distinguishes them, because "Invalid key"
     * pointing at an empty name box would be a lie.
     */
    invalidKey: {
        tone: 'error',
        color: 'red',
        icon: IconX,
        label: (detail) => (detail.field === 'name' ? 'Name required' : 'Invalid key'),
        reason: 'The key fails `^[a-z0-9]+(-[a-z0-9]+)*$` or its length cap, or the name is empty or too long. Zod refuses the save.',
        jumpTo: 'keyField',
    },

    ruleNamesNoRole: {
        tone: 'error',
        color: 'red',
        icon: IconX,
        label: (detail) => `Rule ${(detail.ruleIndex ?? 0) + 1} names no role`,
        reason: 'A roles intent with an empty list, or one naming a declared role the flow does not have. Refused at save and at install respectively.',
        jumpTo: 'rule',
    },
};

/**
 * The chip ids in the order they should be rendered on a row.
 *
 * Not `Object.keys(RESOURCE_CHIPS)`: insertion order is a readable grouping in the
 * source, and render order is a UI judgement that errors come first. A row with a
 * save-blocking problem and a `Private` chip should lead with the problem, because the
 * whole point of scanning the list is finding the rows that cannot save.
 */
export const RESOURCE_CHIP_ORDER: readonly ResourceChipId[] = [
    'duplicateKey',
    'duplicateAdoption',
    'invalidKey',
    'ruleNamesNoRole',
    'nobodyCanSee',
    'perRunOnly',
    'permissionsUntouched',
    'adopted',
    'private',
    'orderedRules',
];

/** Every chip id, for exhaustiveness checks and the doc-sync test. */
export const RESOURCE_CHIP_IDS: readonly ResourceChipId[] = RESOURCE_CHIP_ORDER;

/**
 * Whether a chip means the save or the install will be refused.
 *
 * Asked of the tone rather than of a list of ids, so a chip added as an `error` is
 * counted by the toolbar's red badge without anyone remembering to add it twice.
 */
export function isBlockingChip(id: ResourceChipId): boolean {
    return RESOURCE_CHIPS[id].tone === 'error';
}
