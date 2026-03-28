import type { SimpleGit } from "simple-git";
import type { Octokit } from "@octokit/rest";
import type { RepoIdentity } from "../github/octokit.js";
import { getHttpStatusFromError } from "../http/getHttpStatusFromError.js";
import { planDebugLog } from "./planDebug.js";
import { JARVIS_CI_DIR_RELATIVE } from "./ciImplementArtifacts.js";
import { PR_DRAFT_RELATIVE_PATH } from "./prDraftSchema.js";

const FETCH_MAX_ATTEMPTS = 4;
const FETCH_BASE_DELAY_MS = 1500;

const PUSH_MAX_ATTEMPTS = 6;
const PUSH_BASE_DELAY_MS = 2000;
const PUSH_MAX_DELAY_MS = 45_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function pushBackoffMs(attemptIndexOneBased: number): number {
    const raw = PUSH_BASE_DELAY_MS * 2 ** (attemptIndexOneBased - 1);
    return Math.min(PUSH_MAX_DELAY_MS, raw);
}

function isLikelyNonFastForwardError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes("non-fast-forward") ||
        lower.includes("failed to push") ||
        lower.includes("updates were rejected") ||
        lower.includes("stale info") ||
        lower.includes("fetch first")
    );
}

/**
 * True when the remote has this branch ref.
 */
export async function remotePlanBranchExists(
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

async function withRetries<T>(input: {
    label: string;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs?: number;
    run: () => Promise<T>;
    shouldRetry: (error: unknown) => boolean;
}): Promise<T> {
    let lastError: unknown;
    const cap = input.maxDelayMs ?? 30_000;
    for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
        try {
            return await input.run();
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            planDebugLog(`planImplementationGit: ${input.label} failed`, {
                attempt,
                maxAttempts: input.maxAttempts,
                message,
            });
            if (attempt === input.maxAttempts || !input.shouldRetry(error)) {
                break;
            }
            const delay = Math.min(cap, input.baseDelayMs * 2 ** (attempt - 1));
            await sleep(delay);
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(`planImplementationGit: ${input.label} failed after retries`);
}

/**
 * `git fetch origin` with backoff retries (transient network / GitHub blips).
 */
export async function fetchOriginWithRetry(git: SimpleGit): Promise<void> {
    await withRetries({
        label: "fetch origin",
        maxAttempts: FETCH_MAX_ATTEMPTS,
        baseDelayMs: FETCH_BASE_DELAY_MS,
        run: () => git.fetch("origin"),
        shouldRetry: () => true,
    });
}

export type CheckoutMergedPlanBranchInput = {
    git: SimpleGit;
    branch: string;
    defaultBranch: string;
};

/**
 * Fetch origin, check out `branch` tracking `origin/${branch}`, merge `origin/${defaultBranch}` with --no-edit.
 */
export async function checkoutMergedPlanBranch(input: CheckoutMergedPlanBranchInput): Promise<void> {
    await fetchOriginWithRetry(input.git);
    await input.git.raw(["checkout", "-B", input.branch, `origin/${input.branch}`]);
    await input.git.merge([`--no-edit`, `origin/${input.defaultBranch}`]);
    planDebugLog("planImplementationGit: checked out plan branch merged with default", {
        branch: input.branch,
        defaultBranch: input.defaultBranch,
    });
}

export type PushBranchWithRecoveryInput = {
    git: SimpleGit;
    remote: string;
    branch: string;
};

/**
 * Push `branch` to `remote` with retries. On likely non-fast-forward rejection, fetch and
 * `pull --rebase` before trying again so another automation push does not lose local work.
 */
export async function pushBranchWithRecovery(input: PushBranchWithRecoveryInput): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
        try {
            await input.git.push(input.remote, input.branch);
            planDebugLog("planImplementationGit: push succeeded", {
                branch: input.branch,
                attempt,
            });
            return;
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            planDebugLog("planImplementationGit: push failed", {
                branch: input.branch,
                attempt,
                maxAttempts: PUSH_MAX_ATTEMPTS,
                message,
            });
            if (attempt === PUSH_MAX_ATTEMPTS) {
                break;
            }
            await sleep(pushBackoffMs(attempt));
            try {
                await fetchOriginWithRetry(input.git);
                if (isLikelyNonFastForwardError(message)) {
                    await input.git.raw([
                        "pull",
                        "--rebase",
                        input.remote,
                        input.branch,
                    ]);
                    planDebugLog("planImplementationGit: pulled --rebase before retry", {
                        branch: input.branch,
                    });
                }
            } catch (recoveryError) {
                const recoveryMessage =
                    recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
                planDebugLog("planImplementationGit: pre-push recovery step failed", {
                    branch: input.branch,
                    message: recoveryMessage,
                });
                throw new Error(
                    `Push recovery failed for "${input.branch}" before retry ${String(attempt + 1)}: ${recoveryMessage}`,
                    { cause: recoveryError },
                );
            }
        }
    }
    const finalMessage =
        lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    throw new Error(
        `Failed to push branch "${input.branch}" to ${input.remote} after ${String(PUSH_MAX_ATTEMPTS)} attempts. Last error: ${finalMessage}`,
    );
}

/**
 * Stage all changes except the PR draft artifact (gitignored, but reset HEAD is defensive).
 * @returns Cached diff (staged); empty if nothing to commit.
 */
export async function stageImplementWorktreeExcludingPrDraft(git: SimpleGit): Promise<string> {
    await git.add("-A");
    try {
        await git.raw(["reset", "HEAD", "--", PR_DRAFT_RELATIVE_PATH]);
    } catch {
        /* pr-draft was not staged */
    }
    try {
        await git.raw(["reset", "HEAD", "--", JARVIS_CI_DIR_RELATIVE]);
    } catch {
        /* ci artifacts dir was not staged */
    }
    return await git.diff(["--cached"]);
}

export type CommitAndPushIfStagedInput = {
    git: SimpleGit;
    branch: string;
    remote: string;
    message: string;
};

/**
 * Stages product changes (excluding PR draft + CI artifacts), commits if non-empty, and pushes.
 * @returns whether a commit was created
 */
export async function commitAndPushIfStaged(input: CommitAndPushIfStagedInput): Promise<boolean> {
    const stagedDiff = await stageImplementWorktreeExcludingPrDraft(input.git);
    if (!stagedDiff.trim()) {
        return false;
    }
    await input.git.commit(input.message);
    await pushBranchWithRecovery({ git: input.git, remote: input.remote, branch: input.branch });
    planDebugLog("planImplementationGit: commit pushed", {
        branch: input.branch,
        messageChars: input.message.length,
    });
    return true;
}
