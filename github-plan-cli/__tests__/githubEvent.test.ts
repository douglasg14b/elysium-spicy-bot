import { describe, expect, it } from "vitest";
import { commentMentionsJarvis } from "../src/github/issueCommentEvent.js";

describe("commentMentionsJarvis", () => {
    it("matches word jarvis case-insensitively", () => {
        expect(commentMentionsJarvis("Please use Jarvis to plan")).toBe(true);
        expect(commentMentionsJarvis("JARVIS plan")).toBe(true);
    });

    it("does not match substrings", () => {
        expect(commentMentionsJarvis("ajarvis")).toBe(false);
    });

    it("handles empty input", () => {
        expect(commentMentionsJarvis("")).toBe(false);
        expect(commentMentionsJarvis(null)).toBe(false);
        expect(commentMentionsJarvis(undefined)).toBe(false);
    });
});
