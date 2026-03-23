import { describe, expect, it } from "vitest";
import { parseIntentFromResultFileContents } from "../intentParse.js";

describe("parseIntentFromResultFileContents", () => {
    it("parses clean single-line JSON", () => {
        const raw = JSON.stringify({ intent: "plan", confidence: 1, reason: "x" });
        expect(parseIntentFromResultFileContents(raw)).toEqual({ intent: "plan", runPlan: true });
    });

    it("parses pretty-printed JSON", () => {
        const raw = `{\n  "intent": "implement",\n  "confidence": 0.5,\n  "reason": "y"\n}`;
        expect(parseIntentFromResultFileContents(raw)).toEqual({ intent: "implement", runPlan: false });
    });

    it("strips optional markdown fence", () => {
        const inner = JSON.stringify({ intent: "plan_feedback", confidence: 0.8, reason: "z" });
        const raw = "```json\n" + inner + "\n```";
        expect(parseIntentFromResultFileContents(raw)).toEqual({ intent: "plan_feedback", runPlan: true });
    });

    it("parses when reason contains braces inside the string", () => {
        const raw = JSON.stringify({
            intent: "plan",
            confidence: 1,
            reason: "Use `{foo}` and } in prose",
        });
        expect(parseIntentFromResultFileContents(raw)).toEqual({ intent: "plan", runPlan: true });
    });

    it("returns null for invalid or unknown intent", () => {
        expect(parseIntentFromResultFileContents("")).toBeNull();
        expect(
            parseIntentFromResultFileContents(JSON.stringify({ intent: "nope", confidence: 1, reason: "x" })),
        ).toBeNull();
    });
});
