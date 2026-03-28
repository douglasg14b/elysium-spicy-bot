import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { Octokit } from "@octokit/rest";
import { withAutomationPrefix } from "../config/githubPlanConstants.js";
import {
    assertCursorAgentApiKeyConfigured,
    JARVIS_WORKSPACE_DIR,
    workspaceRoot,
} from "../agent/agentEnv.js";
import {
    assertCursorAgentSucceeded,
    spawnCursorAgent,
    type SpawnCursorAgentOptions,
} from "../agent/cursorAgentSpawn.js";
import {
    implementPrReadyBody,
    postAutomationIssueComment,
    updateIssueComment,
} from "../github/automationComments.js";
import type { RepoIdentity } from "../github/octokit.js";
import { createOrUpdateImplementPullRequest } from "../github/pullRequests.js";
import { loadPrompt } from "../prompts/loadPrompt.js";
import { recordAgentTelemetryStep } from "../telemetry/recordAgentTelemetryStep.js";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import {
    buildSyntheticCiImplementReportForSkippedHeavyPass,
    CI_EXIT_GATE_JSON_SCHEMA,
    CI_IMPLEMENT_REPORT_JSON_SCHEMA,
    CI_REVIEW_AGGREGATE_JSON_SCHEMA,
    type CiImplementReport,
    type CiReviewAggregate,
    archiveCiReviewAggregateBeforeFreshReview,
    buildPreviousReviewAggregatePromptBody,
    buildPrDraftFromCiReports,
    collectBlockingFindingsFromAggregate,
    EXIT_GATE_REPORT_RELATIVE,
    formatBlockingFailureMessage,
    formatCiVerifyRoundsExhaustedMessage,
    formatExitGateFailureMessage,
    formatReviewFeedbackMarkdown,
    formatVerifyFailureMarkdown,
    IMPLEMENT_REPORT_RELATIVE,
    isCiCodeOrchestratedImplement,
    JARVIS_CI_DIR_RELATIVE,
    parseCiExitGateReport,
    parseCiImplementReport,
    parseCiReviewAggregate,
    resolveCiMaxImplementRounds,
    REVIEW_AGGREGATE_RELATIVE,
    REVIEW_FEEDBACK_RELATIVE,
    tailForCiErrorMessage,
    truncateForCiVerifyFeedback,
    VERIFY_FEEDBACK_RELATIVE,
} from "./ciImplementArtifacts.js";
import { getCiBranchProductDiffMetrics, shouldSkipFirstCiImplementPass } from "./ciBranchProductDiff.js";
import { planDebugLog } from "./planDebug.js";
import {
    checkoutMergedPlanBranch,
    commitAndPushIfStaged,
    pushBranchWithRecovery,
    remotePlanBranchExists,
    stageImplementWorktreeExcludingPrDraft,
} from "./planImplementationGit.js";
import { parsePrDraftJson, PR_DRAFT_RELATIVE_PATH, PR_DRAFT_JSON_SCHEMA, type PrDraft } from "./prDraftSchema.js";

const IMPLEMENT_COMMENT_UPDATE_FAILED_STUB =
    "Implementation completed, but GitHub returned an error while updating this status comment.";
const AGENT_TRANSCRIPT_ERROR_PREVIEW_CHARS = 12_000;

function errnoCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

async function updateIssueCommentWithRetry(
    octokit: Octokit,
    repo: RepoIdentity,
    commentId: number,
    body: string,
): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await updateIssueComment(octokit, repo, commentId, body);
            return true;
        } catch (error) {
            planDebugLog("runPlanImplementation: updateIssueComment failed", {
                attempt,
                commentId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return false;
}

/** Verifies the plan file exists, is readable, and is non-empty. */
function assertPlanFileReadableAndNonEmpty(planPath: string): void {
    let text: string;
    try {
        text = readFileSync(planPath, "utf8");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") {
            throw new Error(
                `Missing plan file at .jarvis/plan.md on this branch; generate a plan before implementing.`,
            );
        }
        throw new Error(
            `Cannot read plan file at ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
    if (!text.trim()) {
        throw new Error(".jarvis/plan.md is empty; cannot implement.");
    }
}

function agentTranscriptPreviewForError(transcript: string): string {
    const trimmed = transcript.trim();
    if (!trimmed) {
        return "(agent produced no assistant transcript)";
    }
    return trimmed.length > AGENT_TRANSCRIPT_ERROR_PREVIEW_CHARS
        ? `${trimmed.slice(0, AGENT_TRANSCRIPT_ERROR_PREVIEW_CHARS)}… [truncated]`
        : trimmed;
}

function removePrDraftIfPresent(root: string): void {
    const absolute = join(root, PR_DRAFT_RELATIVE_PATH);
    try {
        unlinkSync(absolute);
    } catch {
        /* absent is fine */
    }
}

/** Ensures a later successful read of the aggregate is from this round’s orchestrator, not a leftover file. */
function removeCiReviewAggregateIfPresent(root: string): void {
    const absolute = join(root, REVIEW_AGGREGATE_RELATIVE);
    try {
        unlinkSync(absolute);
    } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
            throw error;
        }
    }
}

function prepareJarvisCiDir(root: string): void {
    const dir = join(root, JARVIS_CI_DIR_RELATIVE);
    mkdirSync(dir, { recursive: true });
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch (error) {
        throw new Error(
            `Cannot read CI artifact directory ${JARVIS_CI_DIR_RELATIVE}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
    for (const name of names) {
        const absolute = join(dir, name);
        try {
            unlinkSync(absolute);
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") {
                throw new Error(
                    `Cannot remove stale CI artifact ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error },
                );
            }
        }
    }
}

function removeVerifyFeedbackIfPresent(root: string): void {
    const absolute = join(root, VERIFY_FEEDBACK_RELATIVE);
    try {
        unlinkSync(absolute);
    } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
            throw error;
        }
    }
}

function removeExitGateReportIfPresent(root: string): void {
    const absolute = join(root, EXIT_GATE_REPORT_RELATIVE);
    try {
        unlinkSync(absolute);
    } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
            throw error;
        }
    }
}

function readCiImplementRoundFeedbackBody(
    root: string,
    round: number,
    options?: { skippedHeavyImplementerOnRound1?: boolean },
): string {
    if (round <= 1) {
        return [
            "_First implement round — no prior CI feedback._",
            "",
            "After you finish, this workflow runs **`pnpm build`** then **`pnpm test`** on the GitHub Actions runner. If either fails, the next round includes captured output under **Runner verification** below (alongside any blocking review items).",
        ].join("\n");
    }
    const implementerSkipContext =
        options?.skippedHeavyImplementerOnRound1 === true
            ? [
                  "> **Context:** Round 1 skipped the full CI implementer (substantial product diff vs default branch); only runner verification and code review ran before this follow-up round.",
                  "",
              ].join("\n")
            : "";
    let verifySection =
        "_No verify artifact: build and tests passed on the runner before the last review step, or the failure file was already cleared._";
    try {
        const verifyText = readFileSync(join(root, VERIFY_FEEDBACK_RELATIVE), "utf8").trim();
        if (verifyText.length > 0) {
            verifySection = verifyText;
        }
    } catch {
        /* absent is expected when verification passed */
    }
    let reviewSection = "_No prior blocking review feedback._";
    try {
        const reviewText = readFileSync(join(root, REVIEW_FEEDBACK_RELATIVE), "utf8").trim();
        if (reviewText.length > 0) {
            reviewSection = reviewText;
        }
    } catch {
        /* absent */
    }
    return [
        implementerSkipContext,
        "# Prior round feedback",
        "",
        "## Runner verification (`pnpm build` / `pnpm test`)",
        "",
        verifySection,
        "",
        "## Code review (blocking)",
        "",
        reviewSection,
        "",
        "Treat every section above that contains concrete failures or findings as **mandatory** before you set `status` to `completed`.",
    ].join("\n");
}

type PnpmVerifyScript = "build" | "test";

function runPnpmScriptOnRunner(root: string, script: PnpmVerifyScript): {
    ok: boolean;
    exitCode: number | null;
    output: string;
} {
    const useShell = process.platform === "win32";
    const result = spawnSync("pnpm", [script], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        env: process.env,
        shell: useShell,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const output = [stdout, stderr].filter((chunk) => chunk.length > 0).join("\n---\n") || "(no output)";
    if (result.error) {
        return { ok: false, exitCode: null, output: `${result.error.message}\n${output}` };
    }
    return { ok: result.status === 0, exitCode: result.status, output };
}

function logRunnerVerifyFailure(script: PnpmVerifyScript, outcome: { exitCode: number | null; output: string }): void {
    console.error(
        `[github-plan] pnpm ${script} failed on runner (exit ${String(outcome.exitCode)}). Output:\n${outcome.output}`,
    );
}

type CiImplementCommitContext = {
    git: SimpleGit;
    branch: string;
    defaultBranch: string;
    discussionKind: DiscussionKind;
    discussionNumber: number;
};

async function runCiImplementOrchestration(
    root: string,
    planRelative: string,
    commitContext: CiImplementCommitContext,
): Promise<{
    prDraft: PrDraft;
    totalAgentDurationMs: number;
}> {
    prepareJarvisCiDir(root);
    const maxRounds = resolveCiMaxImplementRounds();
    let totalAgentDurationMs = 0;
    let lastImplementReport: CiImplementReport | undefined;
    let lastReviewAggregate: CiReviewAggregate | undefined;
    let skippedHeavyImplementerOnRound1 = false;
    let prDraftFromCiOptions: Parameters<typeof buildPrDraftFromCiReports>[2] | undefined;

    for (let round = 1; round <= maxRounds; round++) {
        planDebugLog("runPlanImplementation: CI implement round", { round, maxRounds });
        let implReport: CiImplementReport;

        const shouldTrySkipHeavyImplementer = round === 1;
        if (shouldTrySkipHeavyImplementer) {
            const diffMetrics = await getCiBranchProductDiffMetrics(
                commitContext.git,
                commitContext.defaultBranch,
            );
            if (shouldSkipFirstCiImplementPass(diffMetrics)) {
                skippedHeavyImplementerOnRound1 = true;
                implReport = buildSyntheticCiImplementReportForSkippedHeavyPass({
                    discussionKind: commitContext.discussionKind,
                    discussionNumber: commitContext.discussionNumber,
                    branchRef: commitContext.branch,
                    metrics: diffMetrics,
                });
                writeFileSync(
                    join(root, IMPLEMENT_REPORT_RELATIVE),
                    `${JSON.stringify(implReport, null, 2)}\n`,
                    "utf8",
                );
                planDebugLog("runPlanImplementation: skipped CI implementer round 1 (substantial branch diff)", {
                    productFileCount: diffMetrics.productFileCount,
                    productLineChurn: diffMetrics.productLineChurn,
                });
            } else {
                const feedbackBody = readCiImplementRoundFeedbackBody(root, round, {
                    skippedHeavyImplementerOnRound1: false,
                });
                const implPrompt = loadPrompt("implement-ci-implementer.md", {
                    PLAN_PATH: planRelative,
                    IMPLEMENT_REPORT_PATH: IMPLEMENT_REPORT_RELATIVE,
                    IMPLEMENT_REPORT_JSON_SCHEMA: CI_IMPLEMENT_REPORT_JSON_SCHEMA,
                    REVIEW_FEEDBACK_BODY: feedbackBody,
                });
                const implSpawn: SpawnCursorAgentOptions = {
                    name: `implementer-ci-r${String(round)}`,
                    workspaceRoot: root,
                    mode: "agent",
                    prompt: implPrompt,
                };
                const implResult = await spawnCursorAgent(implSpawn);
                totalAgentDurationMs += implResult.durationMs;
                assertCursorAgentSucceeded("agent (CI implementer)", implResult, implSpawn);
                recordAgentTelemetryStep({
                    name: `CI implementer round ${String(round)}`,
                    durationMs: implResult.durationMs,
                    usage: implResult.usage,
                });

                let implRaw: string;
                try {
                    implRaw = readFileSync(join(root, IMPLEMENT_REPORT_RELATIVE), "utf8");
                } catch {
                    throw new Error(
                        `CI implementer did not write ${IMPLEMENT_REPORT_RELATIVE}.\n\nAgent transcript preview:\n${agentTranscriptPreviewForError(implResult.assistantTranscript)}`,
                    );
                }
                implReport = parseCiImplementReport(implRaw);
            }
        } else {
            const feedbackBody = readCiImplementRoundFeedbackBody(root, round, {
                skippedHeavyImplementerOnRound1,
            });
            const implPrompt = loadPrompt("implement-ci-implementer-followup.md", {
                PLAN_PATH: planRelative,
                IMPLEMENT_REPORT_PATH: IMPLEMENT_REPORT_RELATIVE,
                IMPLEMENT_REPORT_JSON_SCHEMA: CI_IMPLEMENT_REPORT_JSON_SCHEMA,
                REVIEW_FEEDBACK_BODY: feedbackBody,
            });
            const implSpawn: SpawnCursorAgentOptions = {
                name: `implementer-ci-r${String(round)}`,
                workspaceRoot: root,
                mode: "agent",
                prompt: implPrompt,
            };
            const implResult = await spawnCursorAgent(implSpawn);
            totalAgentDurationMs += implResult.durationMs;
            assertCursorAgentSucceeded("agent (CI implementer)", implResult, implSpawn);
            recordAgentTelemetryStep({
                name: `CI implementer round ${String(round)}`,
                durationMs: implResult.durationMs,
                usage: implResult.usage,
            });

            let implRaw: string;
            try {
                implRaw = readFileSync(join(root, IMPLEMENT_REPORT_RELATIVE), "utf8");
            } catch {
                throw new Error(
                    `CI implementer did not write ${IMPLEMENT_REPORT_RELATIVE}.\n\nAgent transcript preview:\n${agentTranscriptPreviewForError(implResult.assistantTranscript)}`,
                );
            }
            implReport = parseCiImplementReport(implRaw);
        }

        if (implReport.status === "blocked") {
            throw new Error(`CI implementer blocked: ${implReport.blockedReason ?? "unknown"}`);
        }
        if (!implReport.buildSucceeded) {
            planDebugLog(
                "runPlanImplementation: CI implementer did not run a green pnpm build in-agent (common when shell is unavailable); verifying on runner",
                { round },
            );
        }

        const buildOutcome = runPnpmScriptOnRunner(root, "build");
        if (!buildOutcome.ok) {
            logRunnerVerifyFailure("build", buildOutcome);
            const forAgent = truncateForCiVerifyFeedback(buildOutcome.output);
            writeFileSync(
                join(root, VERIFY_FEEDBACK_RELATIVE),
                formatVerifyFailureMarkdown({
                    phase: "build",
                    command: "pnpm build",
                    exitCode: buildOutcome.exitCode,
                    output: forAgent,
                }),
                "utf8",
            );
            if (round === maxRounds) {
                throw new Error(
                    formatCiVerifyRoundsExhaustedMessage({
                        phase: "build",
                        rounds: maxRounds,
                        outputTail: tailForCiErrorMessage(buildOutcome.output),
                    }),
                );
            }
            continue;
        }

        const pushedAfterBuild = await commitAndPushIfStaged({
            git: commitContext.git,
            branch: commitContext.branch,
            remote: "origin",
            message: `jarvis(implement): ${commitContext.discussionKind} #${String(commitContext.discussionNumber)} — CI round ${String(round)} (build ok)`,
        });
        planDebugLog("runPlanImplementation: post-build commit/push", {
            round,
            pushedAfterBuild,
        });

        const testOutcome = runPnpmScriptOnRunner(root, "test");
        if (!testOutcome.ok) {
            logRunnerVerifyFailure("test", testOutcome);
            const forAgent = truncateForCiVerifyFeedback(testOutcome.output);
            writeFileSync(
                join(root, VERIFY_FEEDBACK_RELATIVE),
                formatVerifyFailureMarkdown({
                    phase: "test",
                    command: "pnpm test",
                    exitCode: testOutcome.exitCode,
                    output: forAgent,
                }),
                "utf8",
            );
            if (round === maxRounds) {
                throw new Error(
                    formatCiVerifyRoundsExhaustedMessage({
                        phase: "test",
                        rounds: maxRounds,
                        outputTail: tailForCiErrorMessage(testOutcome.output),
                    }),
                );
            }
            continue;
        }

        removeVerifyFeedbackIfPresent(root);

        archiveCiReviewAggregateBeforeFreshReview(root, round);
        removeCiReviewAggregateIfPresent(root);

        const firstRoundReviewerContext =
            round === 1 && skippedHeavyImplementerOnRound1
                ? "_**Round 1 context:** The CI workflow skipped the full implementer because this branch already had substantial product changes vs the default branch; focus on **runner verification** and **blocking review** only._\n\n"
                : "";

        const revPrompt = loadPrompt("implement-ci-reviewer-orchestrator.md", {
            FIRST_ROUND_IMPLEMENTER_CONTEXT: firstRoundReviewerContext,
            REVIEWER_AGENT_PATH: ".cursor/agents/reviewer.md",
            REVIEW_AGGREGATE_PATH: REVIEW_AGGREGATE_RELATIVE,
            CI_REVIEW_AGGREGATE_JSON_SCHEMA: CI_REVIEW_AGGREGATE_JSON_SCHEMA,
            PREVIOUS_REVIEW_AGGREGATE_BODY: buildPreviousReviewAggregatePromptBody(root, round),
        });
        const revSpawn: SpawnCursorAgentOptions = {
            name: `reviewer-orchestrator-ci-r${String(round)}`,
            workspaceRoot: root,
            mode: "agent",
            prompt: revPrompt,
        };
        const revResult = await spawnCursorAgent(revSpawn);
        totalAgentDurationMs += revResult.durationMs;
        assertCursorAgentSucceeded("agent (CI reviewer orchestrator)", revResult, revSpawn);
        recordAgentTelemetryStep({
            name: revSpawn.name,
            durationMs: revResult.durationMs,
            usage: revResult.usage,
        });

        let aggregateRaw: string;
        try {
            aggregateRaw = readFileSync(join(root, REVIEW_AGGREGATE_RELATIVE), "utf8");
        } catch {
            throw new Error(
                `CI reviewer orchestrator did not write ${REVIEW_AGGREGATE_RELATIVE}.\n\nAgent transcript preview:\n${agentTranscriptPreviewForError(revResult.assistantTranscript)}`,
            );
        }
        const aggregate = parseCiReviewAggregate(aggregateRaw, REVIEW_AGGREGATE_RELATIVE);

        const blocking = collectBlockingFindingsFromAggregate(aggregate);
        lastImplementReport = implReport;
        lastReviewAggregate = aggregate;

        if (blocking.length === 0) {
            break;
        }
        if (round === maxRounds) {
            removeExitGateReportIfPresent(root);
            const gatePrompt = loadPrompt("implement-ci-exit-gate.md", {
                PLAN_PATH: planRelative,
                REVIEW_AGGREGATE_PATH: REVIEW_AGGREGATE_RELATIVE,
                EXIT_GATE_REPORT_PATH: EXIT_GATE_REPORT_RELATIVE,
                CI_EXIT_GATE_JSON_SCHEMA,
            });
            const gateSpawn: SpawnCursorAgentOptions = {
                name: `implement-ci-exit-gate-r${String(round)}`,
                workspaceRoot: root,
                mode: "agent",
                prompt: gatePrompt,
            };
            const gateResult = await spawnCursorAgent(gateSpawn);
            totalAgentDurationMs += gateResult.durationMs;
            assertCursorAgentSucceeded("agent (CI exit gate)", gateResult, gateSpawn);
            recordAgentTelemetryStep({
                name: gateSpawn.name,
                durationMs: gateResult.durationMs,
                usage: gateResult.usage,
            });

            let gateRaw: string;
            try {
                gateRaw = readFileSync(join(root, EXIT_GATE_REPORT_RELATIVE), "utf8");
            } catch {
                throw new Error(
                    formatExitGateFailureMessage({
                        blockingSummary: formatBlockingFailureMessage(blocking),
                        artifactProblem: `Missing ${EXIT_GATE_REPORT_RELATIVE} after exit-gate agent.`,
                    }),
                );
            }
            let gateReport;
            try {
                gateReport = parseCiExitGateReport(gateRaw, EXIT_GATE_REPORT_RELATIVE);
            } catch (error) {
                throw new Error(
                    formatExitGateFailureMessage({
                        blockingSummary: formatBlockingFailureMessage(blocking),
                        artifactProblem: error instanceof Error ? error.message : String(error),
                    }),
                );
            }
            if (gateReport.shipOk) {
                prDraftFromCiOptions = {
                    exitGate: {
                        rationaleMarkdown: gateReport.rationaleMarkdown,
                        waivedBlockingFindings: blocking,
                    },
                };
                break;
            }
            throw new Error(
                formatExitGateFailureMessage({
                    blockingSummary: formatBlockingFailureMessage(blocking),
                    gateRationale: gateReport.rationaleMarkdown,
                }),
            );
        }
        writeFileSync(join(root, REVIEW_FEEDBACK_RELATIVE), formatReviewFeedbackMarkdown(blocking), "utf8");
    }

    if (lastImplementReport === undefined || lastReviewAggregate === undefined) {
        throw new Error("CI implement loop produced no result.");
    }

    const prDraftDraft = buildPrDraftFromCiReports(
        lastImplementReport,
        lastReviewAggregate,
        prDraftFromCiOptions,
    );
    const prDraft = parsePrDraftJson(JSON.stringify(prDraftDraft));
    writeFileSync(join(root, PR_DRAFT_RELATIVE_PATH), `${JSON.stringify(prDraft, null, 2)}\n`, "utf8");
    return { prDraft, totalAgentDurationMs };
}

function appendDiscussionFooter(input: {
    bodyMarkdown: string;
    kind: DiscussionKind;
    number: number;
}): string {
    if (input.kind === "issue") {
        return `${input.bodyMarkdown}\n\n---\n\nFixes #${String(input.number)}`;
    }
    return `${input.bodyMarkdown}\n\n---\n\nRelated to pull request #${String(input.number)}`;
}

function runPnpmBuild(root: string): void {
    const useShell = process.platform === "win32";
    const result = spawnSync("pnpm", ["build"], {
        cwd: root,
        stdio: "inherit",
        env: process.env,
        shell: useShell,
    });
    if (result.error) {
        throw new Error(`pnpm build failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(
            `pnpm build failed with exit code ${String(result.status ?? "unknown")}.`,
        );
    }
}

async function getDefaultBranchOrThrow(
    octokit: Octokit,
    repo: RepoIdentity,
): Promise<string> {
    const { data: repoData } = await octokit.rest.repos.get({
        owner: repo.owner,
        repo: repo.repo,
    });
    const defaultBranch = repoData.default_branch;
    if (!defaultBranch) {
        throw new Error("Repository has no default branch.");
    }
    return defaultBranch;
}

async function createOrUpdatePullRequestWithRetry(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
}): Promise<{ htmlUrl: string }> {
    const maxAttempts = 4;
    const baseDelayMs = 2000;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const { htmlUrl } = await createOrUpdateImplementPullRequest(input);
            return { htmlUrl };
        } catch (error) {
            lastError = error;
            planDebugLog("runPlanImplementation: createOrUpdatePullRequest failed", {
                attempt,
                maxAttempts,
                message: error instanceof Error ? error.message : String(error),
            });
            if (attempt === maxAttempts) {
                break;
            }
            await new Promise((resolve) => {
                setTimeout(resolve, Math.min(20_000, baseDelayMs * 2 ** (attempt - 1)));
            });
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("createOrUpdateImplementPullRequest failed after retries");
}

/**
 * Checkout plan branch, run Cursor implement orchestrator (delegates to generic-implementer),
 * verify build, commit/push product changes, open or update a PR from PR draft JSON.
 *
 * On GitHub Actions (`GITHUB_ACTIONS=true`), uses **code orchestration**: each round runs the CI implementer,
 * then the runner runs **`pnpm build`**, **commits and pushes** incremental progress when there are staged
 * product changes, then **`pnpm test`**.
 * Build/test failures feed the next implement round as `.jarvis/ci/verify-feedback.md` without spawning the reviewer.
 * When verification passes, a reviewer orchestrator runs (`.cursor/agents/reviewer.md`, Task → generic sub-reviewers),
 * writes `.jarvis/ci/review-aggregate.json`, and blocking findings feed the next round via `review-feedback.md`.
 * Up to `resolveCiMaxImplementRounds()` rounds (default **6**, override `CI_MAX_IMPLEMENT_ROUNDS` 1–20), then assembles `pr-draft.json`.
 * On round 1, the implementer may be skipped when product diff vs `origin/<default>` exceeds thresholds; after max rounds with blocking review, an exit-gate agent may allow success.
 */
export async function runPlanImplementation(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    discussionKind: DiscussionKind;
    discussionNumber: number;
}): Promise<{ branch: string; pullRequestUrl: string }> {
    assertCursorAgentApiKeyConfigured();
    const defaultBranch = await getDefaultBranchOrThrow(input.octokit, input.repo);
    let implementThreadCommentId: number | undefined;

    const branch = buildPlanBranchRef({
        kind: input.discussionKind,
        number: input.discussionNumber,
    });

    planDebugLog("runPlanImplementation: start", {
        defaultBranch,
        discussionKind: input.discussionKind,
        discussionNumber: input.discussionNumber,
        branch,
        ciCodeOrchestrator: isCiCodeOrchestratedImplement(),
    });

    const root = workspaceRoot();
    const git = simpleGit(root);
    try {
        implementThreadCommentId = await postAutomationIssueComment(
            input.octokit,
            input.repo,
            input.discussionNumber,
            "Implementing approved plan...",
        );
    } catch {
        /* non-fatal */
    }

    const existsRemote = await remotePlanBranchExists(input.octokit, input.repo, branch);
    if (!existsRemote) {
        throw new Error(
            `Plan branch \`${branch}\` does not exist on the remote yet. Generate a plan first.`,
        );
    }

    await checkoutMergedPlanBranch({ git, branch, defaultBranch });

    const planPath = join(root, JARVIS_WORKSPACE_DIR, "plan.md");
    assertPlanFileReadableAndNonEmpty(planPath);

    const jarvisDir = join(root, JARVIS_WORKSPACE_DIR);
    mkdirSync(jarvisDir, { recursive: true });
    removePrDraftIfPresent(root);

    const planRelative = `${JARVIS_WORKSPACE_DIR}/plan.md`;
    let prDraft: PrDraft;

    if (isCiCodeOrchestratedImplement()) {
        const { prDraft: draft, totalAgentDurationMs } = await runCiImplementOrchestration(
            root,
            planRelative,
            {
                git,
                branch,
                defaultBranch,
                discussionKind: input.discussionKind,
                discussionNumber: input.discussionNumber,
            },
        );
        prDraft = draft;
        recordAgentTelemetryStep({
            name: "Implement from plan (CI code-orchestrated total)",
            durationMs: totalAgentDurationMs,
            usage: undefined,
        });
        planDebugLog("runPlanImplementation: validated PR draft (CI path)", {
            titleChars: prDraft.title.length,
        });
    } else {
        const schemaText = JSON.stringify(PR_DRAFT_JSON_SCHEMA, null, 2);
        const prompt = loadPrompt("implement-run.md", {
            IMPLEMENTER_AGENT_PATH: ".cursor/agents/implementer-generic.md",
            PLAN_PATH: planRelative,
            PR_DRAFT_PATH: PR_DRAFT_RELATIVE_PATH,
            PR_DRAFT_JSON_SCHEMA: schemaText,
        });

        planDebugLog("runPlanImplementation: spawning Cursor agent (implement orchestrator)", {
            promptChars: prompt.length,
        });

        const agentSpawnOptions: SpawnCursorAgentOptions = {
            name: "implement-orchestrator",
            workspaceRoot: root,
            mode: "agent",
            prompt,
        };
        const agentResult = await spawnCursorAgent(agentSpawnOptions);

        assertCursorAgentSucceeded("agent (implement orchestrator)", agentResult, agentSpawnOptions);

        recordAgentTelemetryStep({
            name: "Implement from plan (Cursor agent)",
            durationMs: agentResult.durationMs,
            usage: agentResult.usage,
        });

        const prDraftAbsolute = join(root, PR_DRAFT_RELATIVE_PATH);
        let prDraftRaw: string;
        try {
            prDraftRaw = readFileSync(prDraftAbsolute, "utf8");
        } catch {
            throw new Error(
                `Implement orchestrator did not write ${PR_DRAFT_RELATIVE_PATH}; the agent must write valid JSON there.\n\nAgent transcript preview:\n${agentTranscriptPreviewForError(agentResult.assistantTranscript)}`,
            );
        }
        prDraft = parsePrDraftJson(prDraftRaw);
        planDebugLog("runPlanImplementation: validated PR draft", { titleChars: prDraft.title.length });
    }

    if (!isCiCodeOrchestratedImplement()) {
        runPnpmBuild(root);
    }

    const stagedDiff = await stageImplementWorktreeExcludingPrDraft(git);
    if (!stagedDiff.trim()) {
        if (isCiCodeOrchestratedImplement()) {
            planDebugLog(
                "runPlanImplementation: no final staged changes (CI already pushed incremental commits)",
                { branch },
            );
        } else {
            const hint =
                "The generic-implementer should modify tracked project files; see agent logs.";
            throw new Error(`Implementation produced no staged changes after \`pnpm build\`. ${hint}`);
        }
    } else {
        await git.commit(
            `implement: ${input.discussionKind} #${String(input.discussionNumber)} — ${prDraft.title}`,
        );
        await pushBranchWithRecovery({ git, remote: "origin", branch });
        planDebugLog("runPlanImplementation: pushed commit", { branch });
    }

    const bodyForGithub = appendDiscussionFooter({
        bodyMarkdown: prDraft.bodyMarkdown,
        kind: input.discussionKind,
        number: input.discussionNumber,
    });

    const { htmlUrl } = await createOrUpdatePullRequestWithRetry({
        octokit: input.octokit,
        repo: input.repo,
        baseBranch: defaultBranch,
        headBranch: branch,
        title: prDraft.title,
        body: bodyForGithub,
    });

    if (implementThreadCommentId !== undefined) {
        const finalBody = withAutomationPrefix(implementPrReadyBody(htmlUrl, branch));
        const updated = await updateIssueCommentWithRetry(
            input.octokit,
            input.repo,
            implementThreadCommentId,
            finalBody,
        );
        if (!updated) {
            try {
                await updateIssueComment(
                    input.octokit,
                    input.repo,
                    implementThreadCommentId,
                    withAutomationPrefix(IMPLEMENT_COMMENT_UPDATE_FAILED_STUB),
                );
            } catch {
                /* non-fatal */
            }
        }
    }

    planDebugLog("runPlanImplementation: done", { branch, pullRequestUrl: htmlUrl });
    return { branch, pullRequestUrl: htmlUrl };
}
