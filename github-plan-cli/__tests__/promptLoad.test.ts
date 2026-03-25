import { describe, expect, it } from "vitest";
import { buildVariableBlock, loadPrompt, readPromptFile } from "../src/prompts/loadPrompt.js";

describe("promptLoad", () => {
    it("buildVariableBlock prefixes keys", () => {
        const block = buildVariableBlock({ A: "1", B: "two" });
        expect(block.startsWith("A: 1\nB: two\n\n---\n\n")).toBe(true);
    });

    it("loadPrompt substitutes placeholders", () => {
        const text = loadPrompt("planner-new.md", {
            INTENT_CONTEXT_PATH: ".jarvis/intent-context.md",
            PLAN_OUTPUT_PATH: ".jarvis/plan.md",
        });
        expect(text).toContain("Read .jarvis/intent-context.md");
        expect(text).toContain(".jarvis/plan.md");
        expect(text).not.toContain("{{INTENT_CONTEXT_PATH}}");
    });

    it("readPromptFile returns raw markdown", () => {
        const text = readPromptFile("intent-agent.md");
        expect(text).toContain("intent classification");
        expect(text).toContain('"intent": "plan"');
    });
});
