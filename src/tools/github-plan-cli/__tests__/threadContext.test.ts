import { describe, expect, it } from "vitest";
import {
    AUTO_COMMENT_PREFIX_LINE,
    shouldExcludeCommentFromContext,
    withAutomationPrefix,
} from "../githubPlanConstants.js";
import {
    buildRichIntentContextMarkdown,
    formatCommentThreadSection,
    formatCurrentPlanSection,
} from "../threadContext.js";

describe("shouldExcludeCommentFromContext", () => {
    it("excludes automation prefix", () => {
        expect(shouldExcludeCommentFromContext(`${AUTO_COMMENT_PREFIX_LINE}\nhello`)).toBe(true);
        expect(shouldExcludeCommentFromContext(`  \n${AUTO_COMMENT_PREFIX_LINE}\n`)).toBe(true);
    });

    it("excludes branch pin marker", () => {
        expect(shouldExcludeCommentFromContext("<!-- github-plan-branch-pin:v1 -->\nplan branch")).toBe(
            true,
        );
    });

    it("includes normal human comments", () => {
        expect(shouldExcludeCommentFromContext("Please plan this with cursor")).toBe(false);
    });

    it("excludes null and empty", () => {
        expect(shouldExcludeCommentFromContext(null)).toBe(true);
        expect(shouldExcludeCommentFromContext("")).toBe(true);
    });
});

describe("withAutomationPrefix", () => {
    it("prefixes once", () => {
        expect(withAutomationPrefix("hi")).toBe(`<!-- github-plan:auto:v1 -->\nhi`);
    });

    it("does not double-prefix", () => {
        const once = withAutomationPrefix("x");
        expect(withAutomationPrefix(once)).toBe(once);
    });
});

describe("formatCurrentPlanSection", () => {
    it("returns empty for blank plan", () => {
        expect(formatCurrentPlanSection("  ", "ai/issue-1")).toBe("");
    });

    it("includes branch and body", () => {
        const section = formatCurrentPlanSection("# Plan\n\nStep 1", "ai/issue-2");
        expect(section).toContain("ai/issue-2");
        expect(section).toContain("Step 1");
        expect(section).toContain("## Current plan");
    });
});

describe("formatCommentThreadSection", () => {
    it("renders placeholder when empty", () => {
        expect(formatCommentThreadSection([])).toContain("No human comments");
    });

    it("renders comments in order", () => {
        const md = formatCommentThreadSection([
            { userLogin: "a", createdAt: "t1", body: "first" },
            { userLogin: "b", createdAt: "t2", body: "second" },
        ]);
        expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
        expect(md).toContain("@a");
        expect(md).toContain("@b");
    });
});

describe("buildRichIntentContextMarkdown", () => {
    it("includes description and thread and plan section", () => {
        const md = buildRichIntentContextMarkdown({
            kind: "issue",
            number: 5,
            title: "T",
            body: "B",
            comments: [{ userLogin: "u", createdAt: "2020-01-01", body: "c1" }],
            currentPlanSection: "## Current plan (from branch)\n\nBranch: `ai/issue-5`\n\nold",
        });
        expect(md).toContain("## GitHub issue #5");
        expect(md).toContain("### Title");
        expect(md).toContain("T");
        expect(md).toContain("### Body");
        expect(md).toContain("B");
        expect(md).toContain("Current plan");
        expect(md).toContain("c1");
    });

    it("omits plan block when section empty", () => {
        const md = buildRichIntentContextMarkdown({
            kind: "pull_request",
            number: 3,
            title: "",
            body: "",
            comments: [],
            currentPlanSection: "",
        });
        expect(md).toContain("Pull request #3");
        expect(md).not.toContain("Current plan (from branch)");
    });
});
