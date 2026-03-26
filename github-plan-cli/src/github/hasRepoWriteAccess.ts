import type { Octokit } from "@octokit/rest";
import { getHttpStatusFromError } from "../http/getHttpStatusFromError.js";
import type { RepoIdentity } from "./octokit.js";

const WRITE_LEVELS = new Set(["admin", "maintain", "write"]);

export async function hasRepoWriteAccess(
    octokit: Octokit,
    repo: RepoIdentity,
    username: string,
): Promise<boolean> {
    try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: repo.owner,
            repo: repo.repo,
            username,
        });
        const perm = data.permission ?? "none";
        return WRITE_LEVELS.has(perm);
    } catch (error: unknown) {
        const status = getHttpStatusFromError(error);
        if (status === 404) {
            return false;
        }
        throw error;
    }
}
