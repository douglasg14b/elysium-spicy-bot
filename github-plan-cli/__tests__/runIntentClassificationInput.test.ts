import { describe, expect, it } from "vitest";
import { buildIntentClassifierInputText } from "../src/intent/runIntentClassification.js";

describe("buildIntentClassifierInputText", () => {
    it("includes structured context before comment body", () => {
        const output = buildIntentClassifierInputText({
            text: "Jarvis, go ahead and build this plan",
            hasExistingPlan: true,
            discussionKind: "issue",
        });

        expect(output).toContain("- discussion_kind: issue");
        expect(output).toContain("- has_existing_plan: true");
        expect(output).toContain("Classify the following GitHub comment body:");
        expect(output).toContain("Jarvis, go ahead and build this plan");
    });
});
