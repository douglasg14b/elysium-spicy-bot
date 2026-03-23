import { describe, expect, it } from "vitest";
import { commentMentionsCursor } from "../githubEvent.js";

describe("commentMentionsCursor", () => {
    it("matches word cursor case-insensitively", () => {
        expect(commentMentionsCursor("Please use Cursor to plan")).toBe(true);
        expect(commentMentionsCursor("CURSOR plan")).toBe(true);
    });

    it("does not match substring inside another word", () => {
        expect(commentMentionsCursor("recursor")).toBe(false);
    });

    it("treats empty as false", () => {
        expect(commentMentionsCursor("")).toBe(false);
        expect(commentMentionsCursor(null)).toBe(false);
        expect(commentMentionsCursor(undefined)).toBe(false);
    });
});
