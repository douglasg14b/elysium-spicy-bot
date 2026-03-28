import { describe, expect, it } from "vitest";
import { PR_DRAFT_JSON_SCHEMA } from "../src/plan/prDraftSchema.js";
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

    it("loadPrompt substitutes implement-run placeholders", () => {
        const schemaText = JSON.stringify(PR_DRAFT_JSON_SCHEMA, null, 2);
        const text = loadPrompt("implement-run.md", {
            IMPLEMENTER_AGENT_PATH: ".cursor/agents/implementer-generic.md",
            PLAN_PATH: ".jarvis/plan.md",
            PR_DRAFT_PATH: ".jarvis/pr-draft.json",
            PR_DRAFT_JSON_SCHEMA: schemaText,
        });
        expect(text).toContain(".cursor/agents/implementer-generic.md");
        expect(text).toContain("generic-implementer");
        expect(text).toContain(".jarvis/pr-draft.json");
        expect(text).not.toContain("{{PR_DRAFT_JSON_SCHEMA}}");
    });

    it("loadPrompt substitutes CI implementer follow-up placeholders", () => {
        const text = loadPrompt("implement-ci-implementer-followup.md", {
            PLAN_PATH: ".jarvis/plan.md",
            IMPLEMENT_REPORT_PATH: ".jarvis/ci/implement-report.json",
            IMPLEMENT_REPORT_JSON_SCHEMA: '{"type":"object"}',
            REVIEW_FEEDBACK_BODY: "prior feedback here",
        });
        expect(text).toContain(".jarvis/ci/implement-report.json");
        expect(text).toContain("prior feedback here");
        expect(text).not.toContain("{{IMPLEMENT_REPORT_PATH}}");
        expect(text).not.toContain("{{REVIEW_FEEDBACK_BODY}}");
    });
});
