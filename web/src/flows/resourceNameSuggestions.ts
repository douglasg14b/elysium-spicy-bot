/**
 * Ranking existing guild objects under a name the operator is typing.
 *
 * The panel used to ask two questions in two controls: a **Name** box ("what it gets
 * called when created") and a separate **Does it already exist?** picker. The PRD calls
 * that shape out by name — *"one autocomplete field, not an adopt-or-create fork"* — and
 * the reason is not tidiness. Adoption and creation are the same gesture from the
 * operator's side: they know what the thing is called, and whether it exists already is
 * something the panel can answer for them. Two controls made them answer it twice, and
 * the second answer was optional, so the common mistake was typing `welcome` into a row
 * that then tried to *create* a second `#welcome`.
 *
 * ## Why this is a module and not a component
 *
 * `web/` has no jsdom, so nothing rendered is testable here (see the note at the top of
 * `resourceRows.ts`). Ranking is the part with answers worth checking, so it lives in a
 * plain module the suite can drive and the combobox stays a renderer.
 *
 * ## Why not fuzzy matching
 *
 * `resourceMatchesFilter` in `resourceRows.ts` rejected fuzzy matching for the filter
 * box, on the grounds that a match you cannot predict from looking at the input is worse
 * than one that is slightly too literal. That reasoning holds here for a different
 * reason: this list is not *narrowing* a set the operator can already see, it is
 * proposing a **binding** — and a suggestion that appears for reasons the operator
 * cannot reconstruct is one they will either accept wrongly or learn to distrust. Exact,
 * then prefix, then substring, and nothing else.
 */

import type {
    GuildChannel,
    GuildChannelType,
    GuildRole,
    ResourceKind,
} from '../api/types';
import type { ExistingChannelOption } from './resourceAdoption';

/**
 * How well a candidate matched, worst to best.
 *
 * Ordered numerically so ranking is a sort rather than three concatenated passes, and
 * exported because the combobox groups by it — an exact match is rendered differently
 * from a loose one, since only the exact one carries the save-blocking consequence.
 */
export const SUGGESTION_RANKS = ['substring', 'prefix', 'exact'] as const;
export type SuggestionRank = (typeof SUGGESTION_RANKS)[number];

const RANK_ORDER: Record<SuggestionRank, number> = {
    exact: 0,
    prefix: 1,
    substring: 2,
};

export interface RankedSuggestion {
    /** The option as the adopt pickers already build it — id and display label. */
    readonly option: ExistingChannelOption;
    readonly rank: SuggestionRank;
}

/**
 * Normalise a name the way the server's `findByName` does.
 *
 * `trim().toLowerCase()`, matching `installPlan.ts` exactly. This is load-bearing rather
 * than incidental: `nameCollidesWithExisting` below decides whether to raise a
 * save-blocking chip, and the server decides whether to *block the install*, on what
 * must be the same question. A browser that trimmed differently would either raise a
 * chip the server does not agree with, or — far worse — stay silent on a name the
 * install will refuse.
 */
function normalise(name: string): string {
    return name.trim().toLowerCase();
}

/**
 * Rank the adoptable options against what the operator has typed.
 *
 * Takes options rather than raw channels and roles because `adoptableChannelOptions` and
 * `adoptableRoleOptions` already answer the two questions that must not be re-answered
 * here — which *kind* may adopt which type, and which ids another row has already
 * claimed. Re-deriving either would be a second copy of a rule whose first copy is the
 * one the tests drive.
 *
 * An empty query returns everything, unranked-but-ordered as given. That is the state a
 * freshly opened row is in, and showing nothing until a character is typed would hide
 * the fact that adoption is available at all — which is the discoverability problem the
 * old separate picker had.
 */
export function rankSuggestions(
    options: readonly ExistingChannelOption[],
    query: string
): RankedSuggestion[] {
    const wanted = normalise(query);

    const matched =
        wanted === ''
            ? options.map((option) => ({ option, rank: 'substring' as const }))
            : options.flatMap((option) => {
                  const rank = rankOf(labelToName(option.label), wanted);
                  return rank ? [{ option, rank }] : [];
              });

    return matched.sort((left, right) => {
        const byRank = RANK_ORDER[left.rank] - RANK_ORDER[right.rank];
        // Ties keep the incoming order, which is the guild's own name sort. A
        // secondary sort by label would reorder two equally-good matches for a
        // reason the operator cannot see.
        return byRank !== 0 ? byRank : 0;
    });
}

/**
 * Make options that read identically tell themselves apart.
 *
 * Discord permits duplicate names, and the decoration does not always separate them:
 * two roles called `Verified` are both `@Verified` — a role carries no parent, so
 * `roleOptionLabel` has nothing to qualify with — and two top-level channels called
 * `general` are both `#general`. A dropdown offering the same row twice is the original
 * "which `#general` did I pick?" problem returning one layer up, except worse, because
 * here the operator is choosing rather than merely reading.
 *
 * Suffixing the id is deliberately ugly. The alternative considered was dropping the
 * later duplicates, which would make an object silently unpickable — and the one an
 * operator wants is as likely to be the second as the first. A visible discriminator
 * they can cross-check against Discord beats a list that quietly omits a valid answer.
 *
 * Only the ambiguous ones are touched: a label that appears once is left exactly as it
 * was, so the common case carries no noise.
 *
 * ## Why this runs over the whole list, before ranking and before the cap
 *
 * It used to run inside `rankSuggestions`, over the matched-and-sorted subset, and that
 * put the caller in two label spaces at once: the dropdown showed `@Verified (r2)` while
 * the *committed* row — which resolves its label from the unranked source list — showed
 * a bare `@Verified`. Adopting one of two identical objects then left the UI unable to
 * say which, which is exactly the question this function exists to answer.
 *
 * Disambiguating once, upstream, gives every consumer the same labels. It also has to
 * happen before the `SUGGESTION_LIMIT` cut: whether a label is ambiguous is a fact about
 * the *guild*, and deciding it from a 20-item window would call a name unique because
 * its twin ranked 21st.
 */
export function disambiguateOptions(
    options: readonly ExistingChannelOption[]
): ExistingChannelOption[] {
    const seenCounts = new Map<string, number>();
    for (const option of options) {
        seenCounts.set(option.label, (seenCounts.get(option.label) ?? 0) + 1);
    }

    return options.map((option) =>
        (seenCounts.get(option.label) ?? 0) > 1
            ? { ...option, label: `${option.label} (${option.value})` }
            : option
    );
}

function rankOf(name: string, wanted: string): SuggestionRank | undefined {
    const candidate = normalise(name);
    if (candidate === wanted) return 'exact';
    if (candidate.startsWith(wanted)) return 'prefix';
    if (candidate.includes(wanted)) return 'substring';
    return undefined;
}

/**
 * Recover the bare name from a display label.
 *
 * The labels carry decoration the operator does not type: `#` for a channel, `@` for a
 * role, and ` · in Support` for a channel inside a category. Ranking against the
 * decorated string would mean typing `welcome` never matched `#welcome` as a *prefix* —
 * it would fall to `substring` — and a category-qualified `#general · in Support` would
 * rank below an unqualified `#general` for no reason the operator could see.
 *
 * Parsing the label rather than threading the raw name through is deliberate: the two
 * option builders return `{value, label}` and nothing else, and widening that shape so
 * this function need not parse would mean every consumer of an option carries a field
 * only this one reads.
 */
function labelToName(label: string): string {
    // The ` (id)` an ambiguous label carries goes first, because it is appended last and
    // sits after the parent qualifier. Leaving it on would stop `@Verified (r1)` matching
    // `verified` exactly — demoting the very rows a duplicate name makes hardest to pick
    // out of the tier that ranks them first.
    const withoutId = label.replace(/ \([^()]*\)$/, '');
    const withoutParent = withoutId.split(' · in ')[0] ?? withoutId;
    return withoutParent.replace(/^[#@]/, '');
}

/**
 * Whether a declared name already belongs to something the row is not adopting.
 *
 * **This is the browser's copy of an install-time refusal.** `installPlan.ts` blocks an
 * item whose declared name matches an existing object when no `adoptDiscordId` is set —
 * *"A channel named X already exists. Choose whether to adopt it or create a new one
 * under a different name."* That blocker is correct and stays; what was wrong is *when*
 * the operator met it. They met it after authoring a whole journey and pressing install,
 * named against a resource key rather than the row they typed into.
 *
 * Raising it here makes the state unreachable in the sense that matters: it cannot be
 * saved and it cannot be installed, and the operator resolves it in the row that caused
 * it by picking the suggestion or choosing another name.
 *
 * Deliberately **not** auto-adopting on an exact match, which was the other way to make
 * the state unreachable. The PRD forbids it twice — *"never silently bound to something
 * they did not choose"* and *"a binding is only established by an explicit selection or
 * an explicit new name"* — and the reason survives the convenience: typing a name that
 * happens to collide is not the operator saying "use that one", and a binding they did
 * not intend is one they will not think to check.
 */
export function nameCollidesWithExisting(input: {
    readonly declaredName: string;
    readonly adoptDiscordId: string | undefined;
    /**
     * The names of everything in the guild this kind could collide with.
     *
     * **Unfiltered, and that is the whole point.** The obvious implementation takes the
     * row's adopt *options* — but those have already had ids other rows claim removed
     * (`idsClaimedByOtherRows`), and `findByName` on the server has no such exclusion:
     * it searches the raw guild cache. So a `#welcome` adopted by row A is absent from
     * row B's options while still being exactly what blocks row B's install. Checking
     * the options would leave the chip silent on the one case the operator is least
     * likely to spot unaided.
     *
     * Built by `collidableNamesFor`, which mirrors `findByName`'s kind→type mapping.
     */
    readonly guildNames: readonly string[];
}): boolean {
    // A row that adopts something has resolved the question by definition: the name is
    // the adopted object's, and matching it is the point rather than a collision.
    if (input.adoptDiscordId) return false;

    const wanted = normalise(input.declaredName);
    if (!wanted) return false;

    return input.guildNames.some((name) => normalise(name) === wanted);
}

/**
 * The guild names a declaration of this kind can collide with.
 *
 * Mirrors `findByName` in `installPlan.ts`, which maps `category` to
 * `ChannelType.GuildCategory`, anything else channel-shaped to `GuildText`, and `role`
 * to the role cache. Getting this mapping wrong in either direction is a silent
 * disagreement with the server: too narrow and the chip misses a real blocker, too wide
 * and it blocks a save the install would have accepted.
 *
 * Note a category and a text channel do **not** collide with each other even though
 * both live in the channel list — Discord permits a category and a channel of one name,
 * and so does `findByName`, because it filters on type before comparing.
 */
export function collidableNamesFor(input: {
    readonly kind: ResourceKind;
    readonly channels: readonly GuildChannel[];
    readonly roles: readonly GuildRole[];
}): string[] {
    if (input.kind === 'role') return input.roles.map((role) => role.name);

    const wantedType: GuildChannelType = input.kind === 'category' ? 'category' : 'text';
    return input.channels
        .filter((channel) => channel.type === wantedType)
        .map((channel) => channel.name);
}
