import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    archiveCiReviewAggregateBeforeFreshReview,
    buildPreviousReviewAggregatePromptBody,
    buildPrDraftFromCiReports,
    CI_PREVIOUS_REVIEW_AGGREGATE_PROMPT_MAX_CHARS,
    CI_VERIFY_FEEDBACK_MAX_CHARS,
    collectBlockingFindingsFromAggregate,
    formatBlockingFailureMessage,
    formatCiVerifyRoundsExhaustedMessage,
    formatExitGateFailureMessage,
    formatReviewFeedbackMarkdown,
    formatVerifyFailureMarkdown,
    parseCiExitGateReport,
    parseCiImplementReport,
    parseCiReviewAggregate,
    resolveCiMaxImplementRounds,
    REVIEW_AGGREGATE_PREVIOUS_RELATIVE,
    REVIEW_AGGREGATE_RELATIVE,
    tailForCiErrorMessage,
    truncateForCiPreviousReviewPrompt,
    truncateForCiVerifyFeedback,
} from "../src/plan/ciImplementArtifacts.js";

const NO_PRIOR_NOTE = "_No prior review aggregate in this CI run._";

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

    it("formatVerifyFailureMarkdown wraps output in a fenced block", () => {
        const md = formatVerifyFailureMarkdown({
            phase: "build",
            command: "pnpm build",
            exitCode: 1,
            output: "error TS1005",
        });
        expect(md).toContain("# CI runner verification failed");
        expect(md).toContain("```text");
        expect(md).toContain("error TS1005");
    });

    it("truncateForCiVerifyFeedback truncates long output", () => {
        const long = "x".repeat(CI_VERIFY_FEEDBACK_MAX_CHARS + 50);
        const t = truncateForCiVerifyFeedback(long);
        expect(t.length).toBeLessThan(long.length);
        expect(t).toContain("truncated");
    });

    it("tailForCiErrorMessage keeps the end of long output", () => {
        const long = `HEAD\n${"y".repeat(20_000)}`;
        const tail = tailForCiErrorMessage(long, 100);
        expect(tail).toContain("yyyy");
        expect(tail).not.toContain("HEAD");
    });

    it("formatCiVerifyRoundsExhaustedMessage includes phase and tail", () => {
        const msg = formatCiVerifyRoundsExhaustedMessage({
            phase: "test",
            rounds: 3,
            outputTail: "AssertionError: expected 1 to be 2",
        });
        expect(msg).toContain("pnpm test");
        expect(msg).toContain("3 implement round");
        expect(msg).toContain("AssertionError");
    });

    it("parseCiExitGateReport accepts valid JSON", () => {
        const raw = JSON.stringify({
            version: 1,
            shipOk: true,
            rationaleMarkdown: "All critical items were stale.",
        });
        const g = parseCiExitGateReport(raw, "exit-gate.json");
        expect(g.shipOk).toBe(true);
        expect(g.rationaleMarkdown).toContain("stale");
    });

    it("parseCiExitGateReport rejects invalid JSON", () => {
        expect(() => parseCiExitGateReport("not json", "x.json")).toThrow(/not valid JSON/);
    });

    it("parseCiExitGateReport rejects schema violations", () => {
        const raw = JSON.stringify({ version: 1, shipOk: true });
        expect(() => parseCiExitGateReport(raw, "x.json")).toThrow(/rationaleMarkdown/);
    });

    it("buildPrDraftFromCiReports appends exit gate section when options.exitGate set", () => {
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
            JSON.stringify({ version: 1, findings: [] }),
            "agg.json",
        );
        const highFinding = {
            severity: "high" as const,
            location: "b.ts:1",
            dimension: "d",
            rule: "r",
            impact: "i",
            recommendedFix: "f",
        };
        const draft = buildPrDraftFromCiReports(impl, aggregate, {
            exitGate: {
                rationaleMarkdown: "Gate says OK.",
                waivedBlockingFindings: [highFinding],
            },
        });
        expect(draft.bodyMarkdown).toContain("CI exit gate (automation)");
        expect(draft.bodyMarkdown).toContain("Gate says OK.");
        expect(draft.bodyMarkdown).toContain("Waived blocking findings");
        expect(draft.bodyMarkdown).toContain("b.ts:1");
    });

    it("formatExitGateFailureMessage merges blocking summary and gate rationale", () => {
        const msg = formatExitGateFailureMessage({
            blockingSummary: "blocking summary",
            gateRationale: "still broken",
            artifactProblem: "missing file",
        });
        expect(msg).toContain("blocking summary");
        expect(msg).toContain("Exit gate artifact");
        expect(msg).toContain("missing file");
        expect(msg).toContain("still broken");
    });
});

describe("archiveCiReviewAggregateBeforeFreshReview + buildPreviousReviewAggregatePromptBody", () => {
    const sampleAggregate = JSON.stringify({ version: 1, findings: [] }, null, 2);

    it("round 1 removes stale previous file and prompt body has no-prior note", () => {
        const root = mkdtempSync(join(tmpdir(), "jarvis-archive-r1-"));
        try {
            mkdirSync(join(root, ".jarvis", "ci"), { recursive: true });
            writeFileSync(join(root, REVIEW_AGGREGATE_PREVIOUS_RELATIVE), sampleAggregate, "utf8");
            archiveCiReviewAggregateBeforeFreshReview(root, 1);
            expect(existsSync(join(root, REVIEW_AGGREGATE_PREVIOUS_RELATIVE))).toBe(false);
            expect(buildPreviousReviewAggregatePromptBody(root, 1)).toBe(NO_PRIOR_NOTE);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("round 2+ copies aggregate to previous; main can be removed and prompt still reads previous", () => {
        const root = mkdtempSync(join(tmpdir(), "jarvis-archive-r2-"));
        try {
            mkdirSync(join(root, ".jarvis", "ci"), { recursive: true });
            const mainPath = join(root, REVIEW_AGGREGATE_RELATIVE);
            writeFileSync(mainPath, sampleAggregate, "utf8");
            archiveCiReviewAggregateBeforeFreshReview(root, 2);
            expect(readFileSync(join(root, REVIEW_AGGREGATE_PREVIOUS_RELATIVE), "utf8")).toBe(sampleAggregate);
            unlinkSync(mainPath);
            expect(buildPreviousReviewAggregatePromptBody(root, 2)).toBe(sampleAggregate);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("round 2+ with missing aggregate removes previous and prompt falls back to no-prior note", () => {
        const root = mkdtempSync(join(tmpdir(), "jarvis-archive-miss-"));
        try {
            mkdirSync(join(root, ".jarvis", "ci"), { recursive: true });
            writeFileSync(join(root, REVIEW_AGGREGATE_PREVIOUS_RELATIVE), sampleAggregate, "utf8");
            archiveCiReviewAggregateBeforeFreshReview(root, 2);
            expect(existsSync(join(root, REVIEW_AGGREGATE_PREVIOUS_RELATIVE))).toBe(false);
            expect(buildPreviousReviewAggregatePromptBody(root, 2)).toBe(NO_PRIOR_NOTE);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("truncateForCiPreviousReviewPrompt adds truncation marker when over cap", () => {
        const longBody = "z".repeat(CI_PREVIOUS_REVIEW_AGGREGATE_PROMPT_MAX_CHARS + 100);
        const t = truncateForCiPreviousReviewPrompt(longBody);
        expect(t.length).toBeLessThan(longBody.length);
        expect(t).toContain("truncated for prompt size");
    });
});

describe("resolveCiMaxImplementRounds", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("reads CI_MAX_IMPLEMENT_ROUNDS when valid", () => {
        vi.stubEnv("CI_MAX_IMPLEMENT_ROUNDS", "4");
        expect(resolveCiMaxImplementRounds()).toBe(4);
    });

    it("falls back to default on invalid env", () => {
        vi.stubEnv("CI_MAX_IMPLEMENT_ROUNDS", "0");
        expect(resolveCiMaxImplementRounds()).toBe(6);
    });
});
