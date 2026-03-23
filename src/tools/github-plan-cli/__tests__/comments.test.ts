import { describe, expect, it } from "vitest";
import { buildPlanThreadFinalBody } from "../comments.js";
import { AUTO_COMMENT_PREFIX_LINE } from "../githubPlanConstants.js";

describe("buildPlanThreadFinalBody", () => {
    it("includes branch and no-commit message when nothing was pushed", () => {
        const body = buildPlanThreadFinalBody({
            branchRef: "ai/issue-9",
            committed: false,
            planMarkdown: "# ignored when not committed",
            maxBytes: 60_000,
        });
        expect(body.startsWith(AUTO_COMMENT_PREFIX_LINE)).toBe(true);
        expect(body).toContain("**Plan branch:** `ai/issue-9`");
        expect(body).toContain("no new commit was pushed");
        expect(body).not.toContain("<details>");
    });

    it("includes branch and plan in details when committed", () => {
        const body = buildPlanThreadFinalBody({
            branchRef: "ai/pr-2",
            committed: true,
            planMarkdown: "## Steps\n\n1. Do the thing.",
            maxBytes: 60_000,
        });
        expect(body.startsWith(AUTO_COMMENT_PREFIX_LINE)).toBe(true);
        expect(body).toContain("**Plan branch:** `ai/pr-2`");
        expect(body).toContain("<details>");
        expect(body).toContain("## Steps");
        expect(body).toContain("<summary>Implementation plan</summary>");
    });

    it("uses revised summary and copy when isPlanFeedbackRun", () => {
        const bodyCommitted = buildPlanThreadFinalBody({
            branchRef: "ai/issue-1",
            committed: true,
            planMarkdown: "# X",
            maxBytes: 60_000,
            isPlanFeedbackRun: true,
        });
        expect(bodyCommitted).toContain("<summary>Implementation plan (revised)</summary>");

        const bodyNoCommit = buildPlanThreadFinalBody({
            branchRef: "ai/issue-1",
            committed: false,
            planMarkdown: "# X",
            maxBytes: 60_000,
            isPlanFeedbackRun: true,
        });
        expect(bodyNoCommit).toContain("revised plan matches");
    });
});
