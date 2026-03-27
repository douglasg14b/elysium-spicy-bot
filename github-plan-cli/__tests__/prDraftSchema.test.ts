import { describe, expect, it } from "vitest";
import { parsePrDraftJson } from "../src/plan/prDraftSchema.js";

describe("parsePrDraftJson", () => {
    it("accepts a valid draft", () => {
        const raw = JSON.stringify({
            version: 1,
            title: "Add feature X",
            bodyMarkdown: "## Summary\n\nShipped X.",
        });
        const parsed = parsePrDraftJson(raw);
        expect(parsed.title).toBe("Add feature X");
        expect(parsed.bodyMarkdown).toContain("Shipped X");
    });

    it("rejects invalid JSON", () => {
        expect(() => parsePrDraftJson("not json")).toThrow(/valid JSON/);
    });

    it("rejects wrong version", () => {
        const raw = JSON.stringify({
            version: 2,
            title: "T",
            bodyMarkdown: "B",
        });
        expect(() => parsePrDraftJson(raw)).toThrow(/validation/);
    });

    it("rejects empty title", () => {
        const raw = JSON.stringify({
            version: 1,
            title: "",
            bodyMarkdown: "Body",
        });
        expect(() => parsePrDraftJson(raw)).toThrow(/validation/);
    });
});
