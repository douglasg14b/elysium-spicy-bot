import type { Octokit } from '@octokit/rest';
import { JARVIS_WORKSPACE_DIR } from './agentEnv.js';
import { getHttpStatusFromError } from './httpStatus.js';
import type { RepoIdentity } from './octokit.js';

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
        const text = Buffer.from(data.content, 'base64').toString('utf8');
        return text.trim() === '' ? null : text;
    } catch (error: unknown) {
        const status = getHttpStatusFromError(error);
        if (status === 404) {
            return null;
        }
        throw error;
    }
}
