import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { Octokit } from "@octokit/rest";
import {
    agentModelFromEnv,
    agentSubprocessEnv,
    assertCursorAgentApiKeyConfigured,
    JARVIS_WORKSPACE_DIR,
    workspaceRoot,
} from "./agentEnv.js";
import { formatAgentFailureMessage } from "./agentProcess.js";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import {
    buildPlanThreadFinalBody,
    postAutomationIssueComment,
    postPlanComment,
    updateIssueComment,
    upsertBranchPinComment,
} from "./comments.js";
import { withAutomationPrefix } from "./githubPlanConstants.js";
import { getHttpStatusFromError } from "./httpStatus.js";
import type { RepoIdentity } from "./octokit.js";
import {
    buildRichIntentContextMarkdown,
    formatCurrentPlanSection,
    listIssueCommentsForContext,
} from "./threadContext.js";

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

async function remoteBranchExists(
    octokit: Octokit,
    repo: RepoIdentity,
    branch: string,
): Promise<boolean> {
    try {
        await octokit.rest.repos.getBranch({
            owner: repo.owner,
            repo: repo.repo,
            branch,
        });
        return true;
    } catch (error: unknown) {
        const status = getHttpStatusFromError(error);
        if (status === 404) {
            return false;
        }
        throw error;
    }
}

function readPriorPlanFromWorkspace(planPath: string): string {
    try {
        const text = readFileSync(planPath, "utf8");
        return text.trim() === "" ? "" : text;
    } catch {
        return "";
    }
}

export async function runPlanGeneration(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    discussionKind: DiscussionKind;
    discussionNumber: number;
}): Promise<{ branch: string; planPath: string; committed: boolean }> {
    assertCursorAgentApiKeyConfigured();
    const { data: repoData } = await input.octokit.rest.repos.get({
        owner: input.repo.owner,
        repo: input.repo.repo,
    });
    const defaultBranch = repoData.default_branch;
    if (!defaultBranch) {
        throw new Error("Repository has no default branch.");
    }

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
            "Generating implementation plan...",
        );
    } catch {
        /* non-fatal */
    }

    const root = workspaceRoot();
    const git = simpleGit(root);

    await git.fetch("origin");
    await git.checkout(defaultBranch);
    await git.pull("origin", defaultBranch);

    const exists = await remoteBranchExists(input.octokit, input.repo, branch);
    if (exists) {
        await git.raw(["checkout", "-B", branch, `origin/${branch}`]);
    } else {
        await git.checkoutLocalBranch(branch);
    }

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

    const intentContextPath = `${JARVIS_WORKSPACE_DIR}/intent-context.md`;
    const plannerArgs = [
        "-p",
        "--trust",
        "--workspace",
        root,
        "--mode=plan",
        "--output-format",
        "text",
        "--model",
        agentModelFromEnv(),
        `/planner Read ${intentContextPath} for the GitHub discussion (issue or pull request). It includes the description, optional current plan already on this branch, and the human comment thread. Explore this repository and respond with ONLY the complete implementation plan markdown (no preamble).`,
    ];
    const proc = spawnSync("agent", plannerArgs, {
        encoding: "utf8",
        cwd: root,
        env: agentSubprocessEnv(),
        maxBuffer: 64 * 1024 * 1024,
    });
    if (proc.error) {
        throw proc.error;
    }
    if (proc.status !== 0) {
        throw new Error(
            formatAgentFailureMessage(
                "agent (planner)",
                proc.status,
                proc.stderr ?? "",
                proc.stdout ?? "",
            ),
        );
    }
    const planText = proc.stdout ?? "";
    if (!planText.trim()) {
        throw new Error(`ERROR: ${JARVIS_WORKSPACE_DIR}/plan.md would be empty`);
    }
    writeFileSync(planPath, planText, "utf8");

    await git.add(`${JARVIS_WORKSPACE_DIR}/plan.md`);
    const diff = await git.diff(["--cached"]);
    let committed = false;
    if (diff.trim()) {
        await git.commit(
            `plan: implementation plan for ${input.discussionKind} #${String(input.discussionNumber)}`,
        );
        await git.push("origin", branch);
        committed = true;
    }

    const planMarkdown = readFileSync(planPath, "utf8");
    const finalizeBody = buildPlanThreadFinalBody({
        branchRef: branch,
        committed,
        planMarkdown,
        maxBytes: 60_000,
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
                );
            } else {
                try {
                    await postAutomationIssueComment(
                        input.octokit,
                        input.repo,
                        input.discussionNumber,
                        [
                            `**Plan branch:** \`${branch}\``,
                            "",
                            "The generated plan matches what is already on this branch — no new commit was pushed.",
                        ].join("\n"),
                    );
                } catch {
                    /* non-fatal */
                }
            }
        }
    } else if (committed) {
        await upsertBranchPinComment(input.octokit, input.repo, input.discussionNumber, branch);
        await postPlanComment(input.octokit, input.repo, input.discussionNumber, planMarkdown, 60_000);
    } else {
        try {
            await postAutomationIssueComment(
                input.octokit,
                input.repo,
                input.discussionNumber,
                [
                    `**Plan branch:** \`${branch}\``,
                    "",
                    "The generated plan matches what is already on this branch — no new commit was pushed.",
                ].join("\n"),
            );
        } catch {
            /* non-fatal */
        }
    }

    return { branch, planPath, committed };
}
