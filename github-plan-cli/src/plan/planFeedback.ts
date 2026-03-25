/** True when the run should use revision-style planner instructions (not greenfield-only). */
export function shouldTreatIntentAsPlanFeedback(intent: string, hasExistingPlan: boolean): boolean {
    return intent === "plan_feedback" || (intent === "plan" && hasExistingPlan);
}

/**
 * Boolean written to `plan_is_feedback` in GitHub Actions (`false` when `run_plan` is false so the output key is stable).
 */
export function planIsFeedbackForGithubOutput(runPlan: boolean, semanticFeedback: boolean): boolean {
    return runPlan && semanticFeedback;
}
