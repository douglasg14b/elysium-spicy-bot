import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { Octokit } from "@octokit/rest";
import { agentModelFromEnv, workspaceRoot } from "./agentEnv.js";
import { formatAgentFailureMessage } from "./agentProcess.js";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import {
    postAutomationIssueComment,
    postPlanComment,
    upsertBranchPinComment,
} from "./comments.js";
import { getHttpStatusFromError } from "./httpStatus.js";
import type { RepoIdentity } from "./octokit.js";
import {
    buildRichIntentContextMarkdown,
    formatCurrentPlanSection,
    listIssueCommentsForContext,
} from "./threadContext.js";

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
        return readFileSync(planPath, "utf8");
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

    try {
        await postAutomationIssueComment(
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

    const planPath = join(root, ".claude", "plan.md");
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
    const claudeDir = join(root, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "intent-context.md"), md, "utf8");

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
        "/planner Read .claude/intent-context.md for the GitHub discussion (issue or pull request). It includes the description, optional current plan already on this branch, and the human comment thread. Explore this repository and respond with ONLY the complete implementation plan markdown (no preamble).",
    ];
    const proc = spawnSync("agent", plannerArgs, {
        encoding: "utf8",
        cwd: root,
        env: process.env,
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
        throw new Error("ERROR: .claude/plan.md would be empty");
    }
    writeFileSync(planPath, planText, "utf8");

    await git.add(".claude/plan.md");
    const diff = await git.diff(["--cached"]);
    let committed = false;
    if (diff.trim()) {
        await git.commit(
            `plan: implementation plan for ${input.discussionKind} #${String(input.discussionNumber)}`,
        );
        await git.push("origin", branch);
        committed = true;
    }

    if (committed) {
        await upsertBranchPinComment(
            input.octokit,
            input.repo,
            input.discussionNumber,
            branch,
        );

        const planMarkdown = readFileSync(planPath, "utf8");
        await postPlanComment(input.octokit, input.repo, input.discussionNumber, planMarkdown, 60_000);
    }

    return { branch, planPath, committed };
}
