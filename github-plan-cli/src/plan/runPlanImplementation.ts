import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { Octokit } from "@octokit/rest";
import {
    assertCursorAgentApiKeyConfigured,
    JARVIS_WORKSPACE_DIR,
    workspaceRoot,
} from "../agent/agentEnv.js";
import { assertCursorAgentSucceeded, spawnCursorAgent } from "../agent/cursorAgentSpawn.js";
import { implementPrReadyBody, postAutomationIssueComment } from "../github/automationComments.js";
import type { RepoIdentity } from "../github/octokit.js";
import { createOrUpdateImplementPullRequest } from "../github/pullRequests.js";
import { loadPrompt } from "../prompts/loadPrompt.js";
import { recordAgentTelemetryStep } from "../telemetry/recordAgentTelemetryStep.js";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import { planDebugLog, truncateForPlanDebug } from "./planDebug.js";
import {
    checkoutMergedPlanBranch,
    pushBranchWithRecovery,
    remotePlanBranchExists,
    stageImplementWorktreeExcludingPrDraft,
} from "./planImplementationGit.js";
import { parsePrDraftJson, PR_DRAFT_RELATIVE_PATH, PR_DRAFT_JSON_SCHEMA } from "./prDraftSchema.js";

function readPlanFileOrThrow(planPath: string): void {
    let text: string;
    try {
        text = readFileSync(planPath, "utf8");
    } catch {
        throw new Error(
            `Missing plan file at .jarvis/plan.md on this branch; generate a plan before implementing.`,
        );
    }
    if (!text.trim()) {
        throw new Error(".jarvis/plan.md is empty; cannot implement.");
    }
}

function removePrDraftIfPresent(root: string): void {
    const absolute = join(root, PR_DRAFT_RELATIVE_PATH);
    try {
        unlinkSync(absolute);
    } catch {
        /* absent is fine */
    }
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

async function postPrReadyCommentBestEffort(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    discussionNumber: number;
    htmlUrl: string;
    branch: string;
}): Promise<void> {
    const maxAttempts = 3;
    const baseDelayMs = 1500;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await postAutomationIssueComment(
                input.octokit,
                input.repo,
                input.discussionNumber,
                implementPrReadyBody(input.htmlUrl, input.branch),
            );
            return;
        } catch (error) {
            lastError = error;
            planDebugLog("runPlanImplementation: post PR-ready comment attempt failed", {
                attempt,
                maxAttempts,
                message: truncateForPlanDebug(
                    error instanceof Error ? error.message : String(error),
                    500,
                ),
            });
            if (attempt === maxAttempts) {
                const summary = truncateForPlanDebug(
                    lastError instanceof Error ? lastError.message : String(lastError),
                    400,
                );
                console.error(
                    `[github-plan] Could not post PR-ready issue comment after ${String(maxAttempts)} attempts (PR exists: ${input.htmlUrl}). ${summary}`,
                );
                return;
            }
            await new Promise((resolve) => {
                setTimeout(resolve, baseDelayMs * attempt);
            });
        }
    }
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
 */
export async function runPlanImplementation(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    discussionKind: DiscussionKind;
    discussionNumber: number;
}): Promise<{ branch: string; pullRequestUrl: string }> {
    assertCursorAgentApiKeyConfigured();
    const defaultBranch = await getDefaultBranchOrThrow(input.octokit, input.repo);

    const branch = buildPlanBranchRef({
        kind: input.discussionKind,
        number: input.discussionNumber,
    });

    planDebugLog("runPlanImplementation: start", {
        defaultBranch,
        discussionKind: input.discussionKind,
        discussionNumber: input.discussionNumber,
        branch,
    });

    const root = workspaceRoot();
    const git = simpleGit(root);

    const existsRemote = await remotePlanBranchExists(input.octokit, input.repo, branch);
    if (!existsRemote) {
        throw new Error(
            `Plan branch \`${branch}\` does not exist on the remote yet. Generate a plan first.`,
        );
    }

    await checkoutMergedPlanBranch({ git, branch, defaultBranch });

    const planPath = join(root, JARVIS_WORKSPACE_DIR, "plan.md");
    readPlanFileOrThrow(planPath);

    const jarvisDir = join(root, JARVIS_WORKSPACE_DIR);
    mkdirSync(jarvisDir, { recursive: true });
    removePrDraftIfPresent(root);

    const planRelative = `${JARVIS_WORKSPACE_DIR}/plan.md`;
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

    const agentResult = await spawnCursorAgent({
        name: "implement-orchestrator",
        workspaceRoot: root,
        mode: "agent",
        prompt,
    });

    assertCursorAgentSucceeded("agent (implement orchestrator)", agentResult);

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
            `Implement orchestrator did not write ${PR_DRAFT_RELATIVE_PATH}; the agent must write valid JSON there.`,
        );
    }
    const prDraft = parsePrDraftJson(prDraftRaw);
    planDebugLog("runPlanImplementation: validated PR draft", { titleChars: prDraft.title.length });

    runPnpmBuild(root);

    const stagedDiff = await stageImplementWorktreeExcludingPrDraft(git);
    if (!stagedDiff.trim()) {
        throw new Error(
            "Implementation produced no staged changes after `pnpm build`. The generic-implementer should modify tracked project files; see agent logs.",
        );
    }
    await git.commit(
        `implement: ${input.discussionKind} #${String(input.discussionNumber)} — ${prDraft.title}`,
    );
    await pushBranchWithRecovery({ git, remote: "origin", branch });
    planDebugLog("runPlanImplementation: pushed commit", { branch });

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

    await postPrReadyCommentBestEffort({
        octokit: input.octokit,
        repo: input.repo,
        discussionNumber: input.discussionNumber,
        htmlUrl,
        branch,
    });

    planDebugLog("runPlanImplementation: done", { branch, pullRequestUrl: htmlUrl });
    return { branch, pullRequestUrl: htmlUrl };
}
