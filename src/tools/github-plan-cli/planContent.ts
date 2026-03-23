import type { Octokit } from "@octokit/rest";
import { JARVIS_WORKSPACE_DIR } from "./agentEnv.js";
import { getHttpStatusFromError } from "./httpStatus.js";
import type { RepoIdentity } from "./octokit.js";
import { planDebugLog } from "./planDebug.js";

const PLAN_FILE_PATH = `${JARVIS_WORKSPACE_DIR}/plan.md`;

/**
 * Read `.jarvis/plan.md` at the tip of `branchRef`, if it exists.
 * Returns null on missing file or non-file response.
 */
export async function fetchPlanMarkdownFromBranch(
    octokit: Octokit,
    repo: RepoIdentity,
    branchRef: string,
): Promise<string | null> {
    planDebugLog("fetchPlanMarkdownFromBranch: requesting plan file", {
        path: PLAN_FILE_PATH,
        ref: branchRef,
        repo: `${repo.owner}/${repo.repo}`,
    });
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: PLAN_FILE_PATH,
            ref: branchRef,
        });
        if (Array.isArray(data) || data.type !== 'file') {
            return null;
        }
        if (data.encoding !== 'base64' || typeof data.content !== 'string') {
            return null;
        }
        const text = Buffer.from(data.content, "base64").toString("utf8");
        const trimmed = text.trim();
        if (trimmed === "") {
            planDebugLog("fetchPlanMarkdownFromBranch: file exists but empty", { ref: branchRef });
            return null;
        }
        planDebugLog("fetchPlanMarkdownFromBranch: loaded plan", {
            ref: branchRef,
            chars: trimmed.length,
        });
        return trimmed;
    } catch (error: unknown) {
        const status = getHttpStatusFromError(error);
        if (status === 404) {
            planDebugLog(
                "fetchPlanMarkdownFromBranch: no plan on branch (404 is normal before first plan run)",
                { ref: branchRef, path: PLAN_FILE_PATH },
            );
            return null;
        }
        throw error;
    }
}
