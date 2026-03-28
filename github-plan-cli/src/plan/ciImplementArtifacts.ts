import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DiscussionKind } from "./planBranch.js";
import type { PrDraft } from "./prDraftSchema.js";
import type { CiProductDiffMetrics } from "./ciBranchProductDiff.js";

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
/** Copy of the last round’s aggregate before a fresh review pass; used for reviewer prompt continuity. */
export const REVIEW_AGGREGATE_PREVIOUS_RELATIVE = ".jarvis/ci/review-aggregate-previous.json";

/** Cap prior-round JSON embedded in the CI reviewer prompt. */
export const CI_PREVIOUS_REVIEW_AGGREGATE_PROMPT_MAX_CHARS = 24_000;

const NO_PRIOR_REVIEW_AGGREGATE_PROMPT_NOTE = "_No prior review aggregate in this CI run._";

function errnoCode(error: unknown): string | undefined {
    return error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

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

/**
 * Before spawning a fresh CI reviewer, copy the current `review-aggregate.json` to
 * `review-aggregate-previous.json` so the next prompt can reference the prior round.
 * Round 1 removes any stale previous file; round 2+ copies when the current aggregate exists.
 */
export function archiveCiReviewAggregateBeforeFreshReview(root: string, round: number): void {
    const previousAbsolute = join(root, REVIEW_AGGREGATE_PREVIOUS_RELATIVE);
    const currentAbsolute = join(root, REVIEW_AGGREGATE_RELATIVE);

    if (round <= 1) {
        try {
            unlinkSync(previousAbsolute);
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") {
                throw error;
            }
        }
        return;
    }

    try {
        const raw = readFileSync(currentAbsolute, "utf8");
        writeFileSync(previousAbsolute, raw, "utf8");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") {
            try {
                unlinkSync(previousAbsolute);
            } catch (error2) {
                if (errnoCode(error2) !== "ENOENT") {
                    throw error2;
                }
            }
            return;
        }
        throw error;
    }
}

export function truncateForCiPreviousReviewPrompt(
    body: string,
    maxChars: number = CI_PREVIOUS_REVIEW_AGGREGATE_PROMPT_MAX_CHARS,
): string {
    const trimmed = body.trimEnd();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}\n\n… [truncated for prompt size; original length ${String(trimmed.length)} chars]`;
}

/** Markdown/plain text for the CI reviewer prompt: prior JSON (possibly truncated) or a short “no prior” note. */
export function buildPreviousReviewAggregatePromptBody(root: string, round: number): string {
    if (round <= 1) {
        return NO_PRIOR_REVIEW_AGGREGATE_PROMPT_NOTE;
    }
    const absolute = join(root, REVIEW_AGGREGATE_PREVIOUS_RELATIVE);
    try {
        const raw = readFileSync(absolute, "utf8").trim();
        if (raw.length === 0) {
            return NO_PRIOR_REVIEW_AGGREGATE_PROMPT_NOTE;
        }
        return truncateForCiPreviousReviewPrompt(raw);
    } catch (error) {
        if (errnoCode(error) === "ENOENT") {
            return NO_PRIOR_REVIEW_AGGREGATE_PROMPT_NOTE;
        }
        throw error;
    }
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

/** Combines blocking summary with exit-gate parse failure or gate refusal rationale for a loud failure message. */
export function formatExitGateFailureMessage(input: {
    blockingSummary: string;
    gateRationale?: string;
    artifactProblem?: string;
}): string {
    const lines = [input.blockingSummary];
    if (input.artifactProblem !== undefined && input.artifactProblem.trim() !== "") {
        lines.push("", `**Exit gate artifact:** ${input.artifactProblem.trim()}`);
    }
    if (input.gateRationale !== undefined && input.gateRationale.trim() !== "") {
        lines.push("", "## Exit gate rationale", "", input.gateRationale.trim());
    }
    return lines.join("\n");
}

export type BuildPrDraftFromCiReportsOptions = {
    /** When set, PR body documents that automation waived blocking findings after max rounds. */
    exitGate?: {
        rationaleMarkdown: string;
        waivedBlockingFindings: CiReviewFinding[];
    };
};

export function buildPrDraftFromCiReports(
    implement: CiImplementReport,
    aggregate: CiReviewAggregate,
    options?: BuildPrDraftFromCiReportsOptions,
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

    if (options?.exitGate !== undefined) {
        const gate = options.exitGate;
        bodyMarkdown += "\n\n### CI exit gate (automation)\n\n";
        bodyMarkdown += gate.rationaleMarkdown.trim();
        bodyMarkdown +=
            "\n\nThis run hit the **maximum** CI implement rounds with **critical/high** items still present in the last review aggregate. " +
            "The exit-gate step **accepted** shipping anyway. **Verify manually** unless you agree with the rationale below.\n\n";
        bodyMarkdown += "**Waived blocking findings (last aggregate):**\n\n";
        for (const finding of gate.waivedBlockingFindings) {
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

/** Default when `CI_MAX_IMPLEMENT_ROUNDS` is unset or invalid. */
export const CI_MAX_IMPLEMENT_ROUNDS_DEFAULT = 6;

const ciMaxRoundsEnvSchema = z.coerce.number().int().min(1).max(20);

/**
 * Max CI implement/review cycles (each cycle may run implementer, runner build/test, reviewer).
 * Override with env `CI_MAX_IMPLEMENT_ROUNDS` (integer 1–20).
 */
export function resolveCiMaxImplementRounds(): number {
    const raw = process.env.CI_MAX_IMPLEMENT_ROUNDS;
    if (raw === undefined || raw.trim() === "") {
        return CI_MAX_IMPLEMENT_ROUNDS_DEFAULT;
    }
    const parsed = ciMaxRoundsEnvSchema.safeParse(raw);
    return parsed.success ? parsed.data : CI_MAX_IMPLEMENT_ROUNDS_DEFAULT;
}

/** Written by the CI exit-gate agent when max rounds still have blocking review findings. */
export const EXIT_GATE_REPORT_RELATIVE = ".jarvis/ci/exit-gate.json";

export const ciExitGateReportSchema = z.object({
    version: z.literal(1),
    shipOk: z.boolean(),
    rationaleMarkdown: z.string().min(1),
});

export type CiExitGateReport = z.infer<typeof ciExitGateReportSchema>;

export const CI_EXIT_GATE_JSON_SCHEMA = JSON.stringify(ciExitGateReportSchema.toJSONSchema(), null, 2);

/**
 * Parses exit-gate JSON (`.jarvis/ci/exit-gate.json`).
 * @throws If invalid JSON or schema validation fails.
 */
export function parseCiExitGateReport(raw: string, pathLabel: string): CiExitGateReport {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        throw new Error(`${pathLabel} is not valid JSON.`);
    }
    const result = ciExitGateReportSchema.safeParse(parsed);
    if (!result.success) {
        throw new Error(`${pathLabel} failed validation: ${result.error.message}`);
    }
    return result.data;
}

const SYNTHETIC_CHANGED_PATHS_CAP = 200;

/**
 * When round 1 skips the CI implementer (substantial product diff already on branch), the runner still needs a valid
 * {@link CiImplementReport} for PR draft assembly.
 */
export function buildSyntheticCiImplementReportForSkippedHeavyPass(input: {
    discussionKind: DiscussionKind;
    discussionNumber: number;
    branchRef: string;
    metrics: CiProductDiffMetrics;
}): CiImplementReport {
    const changedPaths = [...input.metrics.productPaths].slice(0, SYNTHETIC_CHANGED_PATHS_CAP);
    const title = `jarvis: verify existing branch work (${input.branchRef})`;
    const kindLabel = input.discussionKind === "pull_request" ? "PR" : "issue";
    const bodyMarkdown = [
        `Continuation run for **${kindLabel} #${String(input.discussionNumber)}** on \`${input.branchRef}\`.`,
        "",
        "The CI workflow **skipped the full implementer** on round 1 because this branch already has **substantial product changes** vs the default branch (per diff thresholds).",
        "",
        `- **Product files touched (unique paths):** ${String(input.metrics.productFileCount)}`,
        `- **Line churn (add+del on product paths):** ${String(input.metrics.productLineChurn)}`,
        "",
        "Use **runner verification** (`pnpm build` / `pnpm test`) and **review feedback** only; avoid broad rewrites of unrelated code.",
    ].join("\n");

    return {
        version: 1,
        status: "completed",
        blockedReason: null,
        buildSucceeded: false,
        changedPaths,
        summaryMarkdown: bodyMarkdown,
        prTitleSuggestion: title,
        prBodyMarkdownSuggestion: bodyMarkdown,
    };
}
