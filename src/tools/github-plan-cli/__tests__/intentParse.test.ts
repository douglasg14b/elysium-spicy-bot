import { describe, expect, it } from "vitest";
import { parseIntentFromAgentJson } from "../intentParse.js";

describe("parseIntentFromAgentJson", () => {
    it("parses top-level intent object", () => {
        const raw = JSON.stringify({ intent: "plan", confidence: 1, reason: "x" });
        expect(parseIntentFromAgentJson(raw)).toEqual({ intent: "plan", runPlan: true });
    });

    it("parses wrapped result string", () => {
        const inner = JSON.stringify({ intent: "implement", confidence: 0.5, reason: "y" });
        const raw = JSON.stringify({ result: inner });
        expect(parseIntentFromAgentJson(raw)).toEqual({ intent: "implement", runPlan: false });
    });

    it("parses double-encoded string in result", () => {
        const inner = JSON.stringify({ intent: "plan_feedback", confidence: 0.8, reason: "z" });
        const raw = JSON.stringify({ result: JSON.stringify(inner) });
        expect(parseIntentFromAgentJson(raw)).toEqual({ intent: "plan_feedback", runPlan: false });
    });

    it("normalizes unknown intent to other", () => {
        const raw = JSON.stringify({ intent: "weird", confidence: 1, reason: "x" });
        expect(parseIntentFromAgentJson(raw)).toEqual({ intent: "other", runPlan: false });
    });

    it("handles invalid JSON", () => {
        expect(parseIntentFromAgentJson("not json")).toEqual({ intent: "other", runPlan: false });
    });

    it("handles empty object", () => {
        expect(parseIntentFromAgentJson("{}")).toEqual({ intent: "other", runPlan: false });
    });
});
