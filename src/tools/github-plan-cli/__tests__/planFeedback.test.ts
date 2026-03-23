import { describe, expect, it } from "vitest";
import { planIsFeedbackForGithubOutput, shouldTreatIntentAsPlanFeedback } from "../planFeedback.js";

describe("shouldTreatIntentAsPlanFeedback", () => {
    it("is true for plan_feedback regardless of existing plan", () => {
        expect(shouldTreatIntentAsPlanFeedback("plan_feedback", false)).toBe(true);
        expect(shouldTreatIntentAsPlanFeedback("plan_feedback", true)).toBe(true);
    });

    it("is true for plan only when a plan exists on the branch", () => {
        expect(shouldTreatIntentAsPlanFeedback("plan", false)).toBe(false);
        expect(shouldTreatIntentAsPlanFeedback("plan", true)).toBe(true);
    });

    it("is false for other intents", () => {
        expect(shouldTreatIntentAsPlanFeedback("implement", true)).toBe(false);
        expect(shouldTreatIntentAsPlanFeedback("other", true)).toBe(false);
    });
});

describe("planIsFeedbackForGithubOutput", () => {
    it("is false when run_plan is false", () => {
        expect(planIsFeedbackForGithubOutput(false, true)).toBe(false);
        expect(planIsFeedbackForGithubOutput(false, false)).toBe(false);
    });

    it("mirrors semantic feedback when run_plan is true", () => {
        expect(planIsFeedbackForGithubOutput(true, true)).toBe(true);
        expect(planIsFeedbackForGithubOutput(true, false)).toBe(false);
    });
});
