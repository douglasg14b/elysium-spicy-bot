import type { Octokit } from "@octokit/rest";
import type { RepoIdentity } from "./octokit.js";

export type PullRequestSummary = {
    readonly number: number;
    readonly htmlUrl: string;
};

/**
 * Find an open pull request whose head branch is `headBranch` on this owner/repo.
 */
export async function findOpenPullRequestForHead(
    octokit: Octokit,
    repo: RepoIdentity,
    headBranch: string,
): Promise<PullRequestSummary | null> {
    const { data } = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: "open",
        head: `${repo.owner}:${headBranch}`,
        per_page: 5,
    });
    const match = data.find((pull) => pull.head?.ref === headBranch);
    if (!match?.html_url) {
        return null;
    }
    return { number: match.number, htmlUrl: match.html_url };
}

export type CreateOrUpdateImplementPrResult = {
    readonly htmlUrl: string;
    readonly created: boolean;
};

/**
 * Create a PR from `headBranch` into `baseBranch`, or update title/body on an existing open PR for that head.
 */
export async function createOrUpdateImplementPullRequest(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
}): Promise<CreateOrUpdateImplementPrResult> {
    const existing = await findOpenPullRequestForHead(input.octokit, input.repo, input.headBranch);
    if (existing !== null) {
        await input.octokit.rest.pulls.update({
            owner: input.repo.owner,
            repo: input.repo.repo,
            pull_number: existing.number,
            title: input.title,
            body: input.body,
        });
        return { htmlUrl: existing.htmlUrl, created: false };
    }
    const { data } = await input.octokit.rest.pulls.create({
        owner: input.repo.owner,
        repo: input.repo.repo,
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
    });
    const htmlUrl = data.html_url;
    if (!htmlUrl) {
        throw new Error("GitHub API returned a pull request without html_url.");
    }
    return { htmlUrl, created: true };
}
