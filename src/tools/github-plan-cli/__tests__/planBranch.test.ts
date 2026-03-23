import { describe, expect, it } from "vitest";
import { buildPlanBranchRef, parsePlanBranchRef } from "../planBranch.js";

describe("buildPlanBranchRef", () => {
    it("builds ai/issue-N for issues", () => {
        expect(buildPlanBranchRef({ kind: "issue", number: 123 })).toBe("ai/issue-123");
    });

    it("builds ai/pr-N for pull_request", () => {
        expect(buildPlanBranchRef({ kind: "pull_request", number: 7 })).toBe("ai/pr-7");
    });

    it("floors integer discussion numbers", () => {
        expect(buildPlanBranchRef({ kind: "issue", number: 9.2 })).toBe("ai/issue-9");
    });

    it("rejects invalid numbers", () => {
        expect(() => buildPlanBranchRef({ kind: "issue", number: 0 })).toThrow();
        expect(() => buildPlanBranchRef({ kind: "issue", number: -1 })).toThrow();
        expect(() => buildPlanBranchRef({ kind: "issue", number: NaN })).toThrow();
    });
});

describe("parsePlanBranchRef", () => {
    it("parses issue branch", () => {
        expect(parsePlanBranchRef("ai/issue-42")).toEqual({ kind: "issue", number: 42 });
    });

    it("parses pr branch", () => {
        expect(parsePlanBranchRef("ai/pr-99")).toEqual({ kind: "pull_request", number: 99 });
    });

    it("strips refs/heads prefix", () => {
        expect(parsePlanBranchRef("refs/heads/ai/issue-1")).toEqual({ kind: "issue", number: 1 });
    });

    it("returns null for invalid refs", () => {
        expect(parsePlanBranchRef("main")).toBeNull();
        expect(parsePlanBranchRef("ai/issue-x")).toBeNull();
        expect(parsePlanBranchRef("automation/plan/issue-1")).toBeNull();
    });
});
