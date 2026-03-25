import { describe, expect, it } from "vitest";
import { INTENT_CLASSIFICATION_SCHEMA } from "../src/intent/intentClassificationSchema.js";

describe("INTENT_CLASSIFICATION_SCHEMA", () => {
    it("accepts valid payloads", () => {
        const payload = { intent: "plan" as const, confidence: 1, reason: "x" };
        expect(INTENT_CLASSIFICATION_SCHEMA.safeParse(payload).success).toBe(true);
    });

    it("rejects unknown intent strings", () => {
        const payload = { intent: "nope", confidence: 1, reason: "x" };
        expect(INTENT_CLASSIFICATION_SCHEMA.safeParse(payload).success).toBe(false);
    });

    it("parses JSON round-trip like the OpenAI message body", () => {
        const raw = JSON.stringify({ intent: "implement", confidence: 0.5, reason: "y" });
        const parsed = INTENT_CLASSIFICATION_SCHEMA.parse(JSON.parse(raw));
        expect(parsed.intent).toBe("implement");
    });
});
