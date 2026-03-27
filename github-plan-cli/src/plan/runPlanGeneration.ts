import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { Octokit } from "@octokit/rest";
import { assertCursorAgentApiKeyConfigured, JARVIS_WORKSPACE_DIR, workspaceRoot } from "../agent/agentEnv.js";
import { assertCursorAgentSucceeded, spawnCursorAgent } from "../agent/cursorAgentSpawn.js";
import { withAutomationPrefix } from "../config/githubPlanConstants.js";
import {
    buildPlanThreadFinalBody,
    createIssueComment,
    postAutomationIssueComment,
    postPlanComment,
    updateIssueComment,
    upsertBranchPinComment,
} from "../github/automationComments.js";
import type { RepoIdentity } from "../github/octokit.js";
import {
    buildRichIntentContextMarkdown,
    formatCurrentPlanSection,
    listIssueCommentsForContext,
} from "../github/issueThreadContext.js";
import { loadPrompt } from "../prompts/loadPrompt.js";
import { recordAgentTelemetryStep } from "../telemetry/recordAgentTelemetryStep.js";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import { planDebugLog } from "./planDebug.js";
import { pushBranchWithRecovery, remotePlanBranchExists } from "./planImplementationGit.js";

const PLAN_COMMENT_UPDATE_FAILED_STUB =
    "Plan output was posted in follow-up comments (GitHub returned an error when updating this message).";

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
        } catch {
            /* try once more */
        }
    }
    return false;
}

function readPriorPlanFromWorkspace(planPath: string): string {
    try {
        const text = readFileSync(planPath, "utf8");
        return text.trim() === "" ? "" : text;
    } catch {
        return "";
    }
}

function readPlanOutputFileOrThrow(planPath: string, relativeLabel: string): string {
    let text: string;
    try {
        text = readFileSync(planPath, "utf8");
    } catch {
        throw new Error(
            `Planner did not produce ${relativeLabel}; the agent must Write the plan to that path.`,
        );
    }
    if (!text.trim()) {
        throw new Error(`ERROR: ${relativeLabel} is empty after planner run`);
    }
    return text;
}

export async function runPlanGeneration(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    discussionKind: DiscussionKind;
    discussionNumber: number;
    /** From CI: revise/update pass vs first plan on branch (local default: false). */
    isPlanFeedbackRun?: boolean;
}): Promise<{ branch: string; planPath: string; committed: boolean }> {
    const isPlanFeedbackRun = input.isPlanFeedbackRun ?? false;
    assertCursorAgentApiKeyConfigured();
    const { data: repoData } = await input.octokit.rest.repos.get({
        owner: input.repo.owner,
        repo: input.repo.repo,
    });
    const defaultBranch = repoData.default_branch;
    if (!defaultBranch) {
        throw new Error("Repository has no default branch.");
    }

    planDebugLog("runPlanGeneration: repo loaded", {
        defaultBranch,
        discussionKind: input.discussionKind,
        discussionNumber: input.discussionNumber,
    });

    const [{ data: issue }, comments] = await Promise.all([
        input.octokit.rest.issues.get({
            owner: input.repo.owner,
            repo: input.repo.repo,
            issue_number: input.discussionNumber,
        }),
        listIssueCommentsForContext(input.octokit, input.repo, input.discussionNumber),
    ]);
    const title = issue.title ?? "";
    const body = issue.body ?? "";

    planDebugLog("runPlanGeneration: issue and comments loaded", {
        titleChars: title.length,
        bodyChars: body.length,
        commentCount: comments.length,
    });

    const branch = buildPlanBranchRef({
        kind: input.discussionKind,
        number: input.discussionNumber,
    });

    let planThreadCommentId: number | undefined;
    try {
        planThreadCommentId = await postAutomationIssueComment(
            input.octokit,
            input.repo,
            input.discussionNumber,
            isPlanFeedbackRun ? "Revising implementation plan..." : "Generating implementation plan...",
        );
    } catch {
        /* non-fatal */
    }

    const root = workspaceRoot();
    const git = simpleGit(root);

    planDebugLog("runPlanGeneration: git fetch and checkout default branch", { defaultBranch });
    await git.fetch("origin");
    await git.checkout(defaultBranch);
    await git.pull("origin", defaultBranch);

    const exists = await remotePlanBranchExists(input.octokit, input.repo, branch);
    planDebugLog("runPlanGeneration: plan branch state", { branch, remoteBranchExists: exists });
    if (exists) {
        await git.raw(["checkout", "-B", branch, `origin/${branch}`]);
    } else {
        await git.checkoutLocalBranch(branch);
    }
    planDebugLog("runPlanGeneration: checked out plan branch", { branch });

    const planPath = join(root, JARVIS_WORKSPACE_DIR, "plan.md");
    const priorPlan = readPriorPlanFromWorkspace(planPath);
    const currentPlanSection =
        priorPlan.trim() !== "" ? formatCurrentPlanSection(priorPlan, branch) : "";

    const md = buildRichIntentContextMarkdown({
        kind: input.discussionKind,
        number: input.discussionNumber,
        title,
        body,
        comments,
        currentPlanSection,
    });
    const jarvisDir = join(root, JARVIS_WORKSPACE_DIR);
    mkdirSync(jarvisDir, { recursive: true });
    writeFileSync(join(jarvisDir, "intent-context.md"), md, "utf8");
    planDebugLog("runPlanGeneration: wrote intent-context.md", {
        path: `${JARVIS_WORKSPACE_DIR}/intent-context.md`,
        markdownChars: md.length,
    });

    const intentContextPath = `${JARVIS_WORKSPACE_DIR}/intent-context.md`;
    const planOutputPath = `${JARVIS_WORKSPACE_DIR}/plan.md`;

    const promptFile = isPlanFeedbackRun ? "planner-revise.md" : "planner-new.md";
    const prompt = loadPrompt(promptFile, {
        INTENT_CONTEXT_PATH: intentContextPath,
        PLAN_OUTPUT_PATH: planOutputPath,
    });

    planDebugLog("runPlanGeneration: spawning Cursor agent (planner)", {
        promptFile,
        promptChars: prompt.length,
    });
    const agentResult = await spawnCursorAgent({
        name: "planner",
        workspaceRoot: root,
        mode: "plan",
        prompt,
    });

    assertCursorAgentSucceeded("agent (planner)", agentResult);

    planDebugLog("runPlanGeneration: Cursor agent finished", {
        exitCode: agentResult.exitCode,
        durationMs: agentResult.durationMs,
    });

    recordAgentTelemetryStep({
        name: "Implementation plan (Cursor agent)",
        durationMs: agentResult.durationMs,
        usage: agentResult.usage,
    });

    const planMarkdown = readPlanOutputFileOrThrow(planPath, planOutputPath);
    planDebugLog("runPlanGeneration: read plan.md from workspace", {
        planMarkdownChars: planMarkdown.length,
    });

    await git.add(`${JARVIS_WORKSPACE_DIR}/plan.md`);
    const diff = await git.diff(["--cached"]);
    let committed = false;
    if (diff.trim()) {
        const subject = isPlanFeedbackRun
            ? `plan: revise implementation plan for ${input.discussionKind} #${String(input.discussionNumber)}`
            : `plan: implementation plan for ${input.discussionKind} #${String(input.discussionNumber)}`;
        planDebugLog("runPlanGeneration: committing and pushing plan branch", { branch });
        await git.commit(subject);
        await pushBranchWithRecovery({ git, remote: "origin", branch });
        committed = true;
    } else {
        planDebugLog("runPlanGeneration: no staged diff; skipping commit/push", { branch });
    }

    const finalizeBody = buildPlanThreadFinalBody({
        branchRef: branch,
        committed,
        planMarkdown,
        maxBytes: 60_000,
        isPlanFeedbackRun,
    });

    planDebugLog("runPlanGeneration: updating issue thread comment", {
        planThreadCommentId:
            planThreadCommentId !== undefined ? planThreadCommentId : "none",
        committed,
    });

    if (planThreadCommentId !== undefined) {
        const updated = await updateIssueCommentWithRetry(
            input.octokit,
            input.repo,
            planThreadCommentId,
            finalizeBody,
        );
        if (!updated) {
            try {
                await updateIssueComment(
                    input.octokit,
                    input.repo,
                    planThreadCommentId,
                    withAutomationPrefix(PLAN_COMMENT_UPDATE_FAILED_STUB),
                );
            } catch {
                /* non-fatal */
            }
            if (committed) {
                await upsertBranchPinComment(
                    input.octokit,
                    input.repo,
                    input.discussionNumber,
                    branch,
                );
                await postPlanComment(
                    input.octokit,
                    input.repo,
                    input.discussionNumber,
                    planMarkdown,
                    60_000,
                    isPlanFeedbackRun,
                );
            } else {
                try {
                    await createIssueComment(
                        input.octokit,
                        input.repo,
                        input.discussionNumber,
                        buildPlanThreadFinalBody({
                            branchRef: branch,
                            committed: false,
                            planMarkdown,
                            maxBytes: 60_000,
                            isPlanFeedbackRun,
                        }),
                    );
                } catch {
                    /* non-fatal */
                }
            }
        }
    } else if (committed) {
        await upsertBranchPinComment(input.octokit, input.repo, input.discussionNumber, branch);
        await postPlanComment(
            input.octokit,
            input.repo,
            input.discussionNumber,
            planMarkdown,
            60_000,
            isPlanFeedbackRun,
        );
    } else {
        try {
            await createIssueComment(
                input.octokit,
                input.repo,
                input.discussionNumber,
                buildPlanThreadFinalBody({
                    branchRef: branch,
                    committed: false,
                    planMarkdown,
                    maxBytes: 60_000,
                    isPlanFeedbackRun,
                }),
            );
        } catch {
            /* non-fatal */
        }
    }

    planDebugLog("runPlanGeneration: done", { branch, committed });
    return { branch, planPath, committed };
}
