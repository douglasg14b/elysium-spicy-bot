/**
 * Whether a flows-list row says anything about its install state, and what.
 *
 * ## The chip rule this obeys
 *
 * `docs/contracts/resource-chips.md` records the vocabulary the resources panel uses and,
 * more usefully, the candidates it rejected: a chip earns its place only when it is **not
 * the default**, **not already visible**, and **something you would act on**. A marker on
 * every row carries no information — it becomes furniture the eye stops reading, and then
 * the one row that needed to speak is indistinguishable from the twenty that did not.
 *
 * Applied here, that disqualifies two of the three states outright:
 *
 * - **Nothing declared** — no chip. There is nothing to install, so "not installed" would
 *   be true and useless, and it would appear on the majority of rows in most guilds.
 * - **Fully installed** — no chip. This is the *resting state* of a journey that is working
 *   correctly, which is the definition of a default. An operator scanning the list wants to
 *   find the ones that need them, not confirm the ones that do not.
 * - **Nothing installed**, and **partly installed** — chips. Both mean a flow is referencing
 *   channels or roles that are not there, which is a live problem with a one-click fix. They
 *   are separated because the fix reads differently: one is "set this up", the other is
 *   "this stopped halfway", and an operator who sees "partly" knows something went wrong
 *   rather than never having been started.
 *
 * The consequence — and it is the point — is that a healthy list has **no install chips at
 * all**, and one appearing means exactly one thing.
 *
 * ## Why this is a module rather than JSX
 *
 * `web/` has no jsdom, so a rule living inside `FlowsListPage.tsx` could not be tested. The
 * decision of *which* states earn a chip is precisely the part that can be silently wrong
 * — it fails by being noisy or by being absent, and neither throws.
 */

import type { FlowJourneyMembership } from '../api/types';

/** What a row's install chip says, and how loudly. */
export interface InstallChip {
    readonly label: string;
    /**
     * Mantine colour. `orange` rather than `red` for both: nothing is broken in the sense
     * of being damaged — the resources have simply not been created yet, which is the
     * normal state of a journey the operator has just finished authoring. Red is reserved
     * for destructive actions and for save-blocking errors in this codebase.
     */
    readonly color: 'orange';
    /** The tooltip, which says what pressing install would actually do. */
    readonly tooltip: string;
}

/**
 * The chip for a journey, or `null` when the row should stay quiet.
 *
 * Takes the membership rather than loose numbers so a caller cannot pair one journey's
 * state with another's count.
 */
export function installChipFor(journey: FlowJourneyMembership | null): InstallChip | null {
    // No journey, or a journey declaring nothing: nothing to install, nothing to say.
    if (!journey || journey.resourceCount === 0) return null;

    switch (journey.installState) {
        case 'all':
            // The resting state. See the module header for why silence is the answer.
            return null;

        case 'none':
            return {
                label: 'Not installed',
                color: 'orange',
                tooltip: `None of the ${journey.resourceCount} declared resource${
                    journey.resourceCount === 1 ? '' : 's'
                } exist in your server yet.`,
            };

        case 'partial':
            return {
                label: `${journey.installedCount}/${journey.resourceCount} installed`,
                color: 'orange',
                tooltip:
                    'Some declared resources are missing from your server — an install ' +
                    'that stopped short, or something added since.',
            };

        default: {
            /*
             * Exhaustiveness at **compile** time, silence at runtime.
             *
             * The `never` assignment is what matters: a fourth `JourneyInstallState` cannot
             * be added without an arm here, which is the failure this module could not
             * otherwise detect by looking at it.
             *
             * It does **not** throw. The value arrives over the wire and is `as`-cast rather
             * than parsed, so a widened server union reaches here as a real value — and
             * `web/src` has no error boundary anywhere, so throwing on a render path blanks
             * the entire dashboard rather than losing one badge. Losing the badge is the
             * proportionate failure. Same idiom as `handleDragEnd` in `FlowsListPage`.
             */
            const unhandled: never = journey.installState;
            void unhandled;
            return null;
        }
    }
}

/**
 * The query parameter that hands a flow off to the builder's install wizard.
 *
 * Here because this module already owns the chip-and-button rule, and the button is the
 * only thing that produces it. It was a bare `'install'` written out on both pages —
 * `FlowsListPage` builds the URL, `FlowBuilderPage` reads and strips it — and a rename on
 * one side would typecheck, pass every test, and silently degrade the Install button into a
 * plain navigation. That reads as a slow page rather than as a bug.
 */
export const INSTALL_QUERY_PARAM = 'install';

/*
 * `shouldOfferInstall` was here, returning `installChipFor(journey) !== null`.
 *
 * Deleted as dead code: `InstallState` in `FlowsListPage` enforces the rule directly with an
 * early return on a null chip, so the predicate had no caller but its own test — which
 * asserted it agreed with the one-line body it was made of. The invariant it named is real
 * and still holds (**a chip and the button appear together**: a chip without the fix beside
 * it is a notification, and a button on a row with no chip is an action for a state nobody
 * was told about), so it is written down here rather than re-exported as a function.
 */
