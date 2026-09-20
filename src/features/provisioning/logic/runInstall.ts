import type { Guild } from 'discord.js';
import { isPlanApplicable, type InstallPlan } from './installPlan';
import type { JourneyDeclaration } from './resourceDeclaration';
import { installJourney, previewInstall } from '../provisioningService';
import { runResourceWriteBack, type ResourceWriteBackResult } from '../resourceWriteBack';
import type { AppliedResource } from './applyInstallPlan';

/**
 * The one sequence that installs a journey, for every surface that offers to.
 *
 * Extracted from the retired `/install-journey` Apply button so the dashboard's install
 * route could share one sequence; that route is now the only caller. The steps are not
 * incidental to whichever surface calls them — each one is load bearing, and a second
 * copy would be a second place for one of them to go missing:
 *
 *   1. **rebuild the plan** rather than accept the approved one. The browser could POST
 *      one, and must not be allowed to, because a plan on the wire is a list of
 *      snowflakes a client asked us to mutate.
 *   2. **re-check applicability**, so a guild that drifted between preview and press
 *      is caught here rather than failing partway through the apply.
 *   3. **apply**, which may stop partway and still have created real objects.
 *   4. **write back**, even after a partial apply — see below.
 *
 * Returns the rebuilt plan on refusal so a caller can show the operator *why* their
 * approval no longer holds. Showing the stale one would be showing them the plan they
 * already agreed to and calling it a refusal.
 */
export type InstallRunOutcome =
    | {
          readonly status: 'notApplicable';
          /** The rebuilt plan, carrying the blockers that were not there at preview. */
          readonly plan: InstallPlan;
      }
    | {
          readonly status: 'applied';
          readonly plan: InstallPlan;
          readonly applied: readonly AppliedResource[];
          readonly writeBack: ResourceWriteBackResult;
          /**
           * What stopped the apply partway, if anything.
           *
           * Still `applied`, not a failure: the resources in `applied` are real and
           * bound, re-running install converges rather than duplicating, and the
           * write-back has already wired up what exists. A caller reports this beside
           * the successes, never in place of them.
           */
          readonly failure?: string;
      };

export interface RunInstallInput {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
    readonly staffRoleIds: readonly string[];
}

/**
 * Preview, check, apply, and wire up the result.
 *
 * Throws nothing of its own: an apply that fails partway comes back as `failure` on an
 * `applied` outcome, and a write-back that throws is swallowed and logged inside
 * {@link runResourceWriteBack} because the guild has already been mutated by then.
 * Anything that does throw out of here is a genuine fault, which each surface reports
 * in its own vocabulary.
 */
export async function runInstall(input: RunInstallInput): Promise<InstallRunOutcome> {
    const { guild, journey, staffRoleIds } = input;

    const plan = await previewInstall({ guild, journey, staffRoleIds });

    if (!isPlanApplicable(plan)) {
        return { status: 'notApplicable', plan };
    }

    const result = await installJourney({
        guild,
        journey,
        approvedPlan: plan,
        staffRoleIds,
    });

    /*
     * Write the new ids into whatever consumes these resources.
     *
     * Runs even on a partial install: what was applied is real and bound, and the
     * nodes pointing at it should stop waiting. Anything still unresolved comes back
     * in `writeBack.unresolved` rather than being left for the operator to discover at
     * run time.
     *
     * Reached through a registered hook rather than by importing flows, because
     * provisioning is a base capability and flows are one of its consumers. The import
     * would work today and invert the dependency permanently.
     */
    const writeBack = await runResourceWriteBack(guild, journey.journeyKey);

    return {
        status: 'applied',
        plan,
        applied: result.applied,
        writeBack,
        failure: result.failure,
    };
}
