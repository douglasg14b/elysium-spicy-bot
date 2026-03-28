import { z } from "zod";
import type { PrDraft } from "./prDraftSchema.js";

/** CI-only artifacts under `.jarvis/ci/` (gitignored). */
export const JARVIS_CI_DIR_RELATIVE = ".jarvis/ci";
export const IMPLEMENT_REPORT_RELATIVE = ".jarvis/ci/implement-report.json";
export const REVIEW_FEEDBACK_RELATIVE = ".jarvis/ci/review-feedback.md";
/** Written when the GitHub Actions runner’s `pnpm build` or `pnpm test` fails; consumed on the next implement round. */
export const VERIFY_FEEDBACK_RELATIVE = ".jarvis/ci/verify-feedback.md";

/** Cap captured stdout/stderr in verify feedback so implement prompts stay bounded. */
export const CI_VERIFY_FEEDBACK_MAX_CHARS = 48_000;
/** Single merged output from the orchestrating reviewer (`.cursor/agents/reviewer.md` + Task → generic reviewers). */
export const REVIEW_AGGREGATE_RELATIVE = ".jarvis/ci/review-aggregate.json";

const findingSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const ciReviewFindingSchema = z.object({
    severity: findingSeveritySchema,
    location: z.string().min(1),
    dimension: z.string().min(1),
    rule: z.string().min(1),
    impact: z.string().min(1),
    recommendedFix: z.string().min(1),
});

export type CiReviewFinding = z.infer<typeof ciReviewFindingSchema>;

export const ciReviewAggregateSchema = z.object({
    version: z.literal(1),
    findings: z.array(ciReviewFindingSchema),
});

export type CiReviewAggregate = z.infer<typeof ciReviewAggregateSchema>;

export const CI_REVIEW_AGGREGATE_JSON_SCHEMA = JSON.stringify(ciReviewAggregateSchema.toJSONSchema(), null, 2);

export const ciImplementReportSchema = z
    .object({
        version: z.literal(1),
        status: z.enum(["completed", "blocked"]),
        blockedReason: z.string().nullable(),
        buildSucceeded: z.boolean(),
        changedPaths: z.array(z.string()),
        summaryMarkdown: z.string().min(1),
        prTitleSuggestion: z.string().optional(),
        prBodyMarkdownSuggestion: z.string().optional(),
    })
    .superRefine((data, ctx) => {
        if (data.status === "blocked") {
            if (data.blockedReason === null || data.blockedReason.trim() === "") {
                ctx.addIssue({
                    code: "custom",
                    message: "blockedReason is required when status is blocked",
                    path: ["blockedReason"],
                });
            }
        }
        if (data.status === "completed") {
            if (!data.prTitleSuggestion?.trim()) {
                ctx.addIssue({
                    code: "custom",
                    message: "prTitleSuggestion is required when status is completed",
                    path: ["prTitleSuggestion"],
                });
            }
            if (!data.prBodyMarkdownSuggestion?.trim()) {
                ctx.addIssue({
                    code: "custom",
                    message: "prBodyMarkdownSuggestion is required when status is completed",
                    path: ["prBodyMarkdownSuggestion"],
                });
            }
        }
    });

export type CiImplementReport = z.infer<typeof ciImplementReportSchema>;

export const CI_IMPLEMENT_REPORT_JSON_SCHEMA = JSON.stringify(ciImplementReportSchema.toJSONSchema(), null, 2);

/**
 * Parses and validates CI implementer JSON (typically `.jarvis/ci/implement-report.json`).
 * @throws If `raw` is not JSON or fails `ciImplementReportSchema` (message references implement report path).
 */
export function parseCiImplementReport(raw: string): CiImplementReport {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        throw new Error(`${IMPLEMENT_REPORT_RELATIVE} is not valid JSON.`);
    }
    const result = ciImplementReportSchema.safeParse(parsed);
    if (!result.success) {
        throw new Error(`${IMPLEMENT_REPORT_RELATIVE} failed validation: ${result.error.message}`);
    }
    return result.data;
}

/**
 * Parses and validates merged CI review JSON (`pathLabel` is used only in error messages).
 * @throws If `raw` is not JSON or fails `ciReviewAggregateSchema`.
 */
export function parseCiReviewAggregate(raw: string, pathLabel: string): CiReviewAggregate {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        throw new Error(`${pathLabel} is not valid JSON.`);
    }
    const result = ciReviewAggregateSchema.safeParse(parsed);
    if (!result.success) {
        throw new Error(`${pathLabel} failed validation: ${result.error.message}`);
    }
    return result.data;
}

export function isBlockingCiFinding(finding: CiReviewFinding): boolean {
    return finding.severity === "critical" || finding.severity === "high";
}

export function collectBlockingFindingsFromAggregate(aggregate: CiReviewAggregate): CiReviewFinding[] {
    return aggregate.findings.filter(isBlockingCiFinding);
}

export function truncateForCiVerifyFeedback(
    output: string,
    maxChars: number = CI_VERIFY_FEEDBACK_MAX_CHARS,
): string {
    const trimmed = output.trimEnd();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}\n\n… [truncated; original length ${String(trimmed.length)} chars]`;
}

export function tailForCiErrorMessage(output: string, maxChars: number = 12_000): string {
    const trimmed = output.trimEnd();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `… [${String(trimmed.length - maxChars)} chars omitted from start]\n${trimmed.slice(-maxChars)}`;
}

export function formatVerifyFailureMarkdown(input: {
    phase: "build" | "test";
    command: string;
    exitCode: number | null;
    output: string;
}): string {
    const body = input.output.trimEnd() || "(empty)";
    return [
        "# CI runner verification failed",
        "",
        `**Phase:** \`${input.phase}\``,
        `**Command:** \`${input.command}\``,
        `**Exit code:** ${input.exitCode === null ? "(unknown)" : String(input.exitCode)}`,
        "",
        "## Output",
        "",
        "```text",
        body,
        "```",
        "",
        "Fix the errors above. The workflow will run `pnpm build` and `pnpm test` on the runner again after your next report.",
    ].join("\n");
}

export function formatCiVerifyRoundsExhaustedMessage(input: {
    phase: "build" | "test";
    rounds: number;
    outputTail: string;
}): string {
    const script = input.phase === "build" ? "pnpm build" : "pnpm test";
    return [
        `CI implementation used ${String(input.rounds)} implement round(s) but \`${script}\` still failed on the GitHub Actions runner.`,
        "",
        "Last captured output (tail):",
        "",
        "```text",
        input.outputTail.trimEnd() || "(empty)",
        "```",
    ].join("\n");
}

export function formatReviewFeedbackMarkdown(findings: CiReviewFinding[]): string {
    if (findings.length === 0) {
        return "";
    }
    const lines = [
        "# Review feedback (blocking)",
        "",
        "Address every **critical** and **high** item below, then re-run verification (`pnpm build` and `pnpm test` as appropriate).",
        "",
    ];
    let index = 1;
    for (const finding of findings) {
        lines.push(
            `## ${String(index)}. ${finding.severity.toUpperCase()} — ${finding.location}`,
            "",
            `- **Dimension:** ${finding.dimension}`,
            `- **Rule / guidance:** ${finding.rule}`,
            `- **Impact:** ${finding.impact}`,
            `- **Fix:** ${finding.recommendedFix}`,
            "",
        );
        index += 1;
    }
    return lines.join("\n");
}

export function formatBlockingFailureMessage(findings: CiReviewFinding[]): string {
    const preview = findings
        .slice(0, 12)
        .map((f) => `- [${f.severity}] ${f.location}: ${f.impact}`)
        .join("\n");
    const more =
        findings.length > 12 ? `\n… and ${String(findings.length - 12)} more blocking finding(s).` : "";
    return `CI review still has blocking findings after max implement rounds:\n${preview}${more}`;
}

export function buildPrDraftFromCiReports(
    implement: CiImplementReport,
    aggregate: CiReviewAggregate,
): PrDraft {
    const title = implement.prTitleSuggestion ?? "Implement plan";
    let bodyMarkdown = implement.prBodyMarkdownSuggestion ?? implement.summaryMarkdown;

    const nonBlocking = aggregate.findings.filter(
        (finding) => finding.severity === "medium" || finding.severity === "low",
    );
    if (nonBlocking.length > 0) {
        bodyMarkdown += "\n\n### Automated review notes (non-blocking)\n\n";
        for (const finding of nonBlocking) {
            bodyMarkdown += `- **${finding.severity}** \`${finding.location}\`: ${finding.impact}\n`;
        }
    }

    return {
        version: 1,
        title,
        bodyMarkdown,
    };
}

/**
 * When true, `runPlanImplementation` uses code orchestration + CI agent prompts (implementer-ci + reviewer aggregate).
 * GitHub Actions sets `GITHUB_ACTIONS` to the string `"true"`; other truthy spellings (`1`, `yes`) are not treated as CI.
 */
export function isCiCodeOrchestratedImplement(): boolean {
    return process.env.GITHUB_ACTIONS === "true";
}

export const CI_MAX_IMPLEMENT_ROUNDS = 3;
