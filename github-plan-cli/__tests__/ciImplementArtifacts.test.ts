import { describe, expect, it } from "vitest";
import {
    buildPrDraftFromCiReports,
    collectBlockingFindingsFromAggregate,
    formatBlockingFailureMessage,
    formatReviewFeedbackMarkdown,
    parseCiImplementReport,
    parseCiReviewAggregate,
} from "../src/plan/ciImplementArtifacts.js";

describe("ciImplementArtifacts", () => {
    it("parses completed implement report", () => {
        const raw = JSON.stringify({
            version: 1,
            status: "completed",
            blockedReason: null,
            buildSucceeded: true,
            changedPaths: ["src/foo.ts"],
            summaryMarkdown: "Done.",
            prTitleSuggestion: "Add foo",
            prBodyMarkdownSuggestion: "Implements foo.",
        });
        const report = parseCiImplementReport(raw);
        expect(report.status).toBe("completed");
        expect(report.buildSucceeded).toBe(true);
    });

    it("rejects completed report without PR fields", () => {
        const raw = JSON.stringify({
            version: 1,
            status: "completed",
            blockedReason: null,
            buildSucceeded: true,
            changedPaths: [],
            summaryMarkdown: "x",
        });
        expect(() => parseCiImplementReport(raw)).toThrow(/prTitleSuggestion/);
    });

    it("collects blocking findings from aggregate", () => {
        const raw = JSON.stringify({
            version: 1,
            findings: [
                {
                    severity: "low",
                    location: "a.ts:1",
                    dimension: "general",
                    rule: "x",
                    impact: "y",
                    recommendedFix: "z",
                },
                {
                    severity: "high",
                    location: "b.ts:2",
                    dimension: "general",
                    rule: "x",
                    impact: "y",
                    recommendedFix: "z",
                },
            ],
        });
        const aggregate = parseCiReviewAggregate(raw, "test.json");
        const blocking = collectBlockingFindingsFromAggregate(aggregate);
        expect(blocking).toHaveLength(1);
        expect(blocking[0].severity).toBe("high");
    });

    it("buildPrDraftFromCiReports appends non-blocking notes from aggregate", () => {
        const impl = parseCiImplementReport(
            JSON.stringify({
                version: 1,
                status: "completed",
                blockedReason: null,
                buildSucceeded: true,
                changedPaths: ["a.ts"],
                summaryMarkdown: "Summary",
                prTitleSuggestion: "T",
                prBodyMarkdownSuggestion: "Body",
            }),
        );
        const aggregate = parseCiReviewAggregate(
            JSON.stringify({
                version: 1,
                findings: [
                    {
                        severity: "medium",
                        location: "a.ts:1",
                        dimension: "d",
                        rule: "r",
                        impact: "i",
                        recommendedFix: "f",
                    },
                ],
            }),
            "agg.json",
        );
        const draft = buildPrDraftFromCiReports(impl, aggregate);
        expect(draft.title).toBe("T");
        expect(draft.bodyMarkdown).toContain("Automated review notes");
    });

    it("formatBlockingFailureMessage includes preview", () => {
        const msg = formatBlockingFailureMessage([
            {
                severity: "critical",
                location: "x.ts:1",
                dimension: "d",
                rule: "r",
                impact: "bad",
                recommendedFix: "fix",
            },
        ]);
        expect(msg).toContain("critical");
        expect(msg).toContain("x.ts:1");
    });

    it("formatReviewFeedbackMarkdown documents blocking findings", () => {
        const md = formatReviewFeedbackMarkdown([
            {
                severity: "high",
                location: "src/a.ts:10",
                dimension: "runtime",
                rule: "AGENTS.md",
                impact: "Race when handling interaction",
                recommendedFix: "Await deferral",
            },
        ]);
        expect(md).toContain("# Review feedback (blocking)");
        expect(md).toContain("## 1. HIGH — src/a.ts:10");
        expect(md).toContain("**Dimension:** runtime");
        expect(md).toContain("pnpm build");
    });

    it("formatReviewFeedbackMarkdown returns empty string when no findings", () => {
        expect(formatReviewFeedbackMarkdown([])).toBe("");
    });
});
