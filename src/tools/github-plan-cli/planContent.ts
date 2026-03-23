import type { Octokit } from "@octokit/rest";
import { getHttpStatusFromError } from "./httpStatus.js";
import type { RepoIdentity } from "./octokit.js";

/**
 * Read `.claude/plan.md` at the tip of `branchRef`, if it exists.
 * Returns null on missing file or non-file response.
 */
export async function fetchPlanMarkdownFromBranch(
    octokit: Octokit,
    repo: RepoIdentity,
    branchRef: string,
): Promise<string | null> {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: ".claude/plan.md",
            ref: branchRef,
        });
        if (Array.isArray(data) || data.type !== "file") {
            return null;
        }
        if (data.encoding !== "base64" || typeof data.content !== "string") {
            return null;
        }
        return Buffer.from(data.content, "base64").toString("utf8");
    } catch (error: unknown) {
        const status = getHttpStatusFromError(error);
        if (status === 404) {
            return null;
        }
        throw error;
    }
}
