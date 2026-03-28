import type { Octokit } from "@octokit/rest";
import type { RepoIdentity } from "./octokit.js";

export type PullRequestSummary = {
    readonly number: number;
    readonly htmlUrl: string;
};

function isGitHubActionsPrCreationNotPermittedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("GitHub Actions is not permitted to create or approve pull requests")) {
        return false;
    }

    if (typeof error !== "object" || error === null) {
        return true;
    }

    const maybeStatus = (error as Record<string, unknown>).status;
    const status = typeof maybeStatus === "number" ? maybeStatus : undefined;
    return status === undefined || status === 401 || status === 403;
}

function buildGitHubActionsPrCreationNotPermittedHelpMessage(): string {
    return [
        "GitHub rejected the attempt to create/update a pull request using the workflow GITHUB_TOKEN.",
        "",
        "Fix:",
        '- Enable the repository/org setting: Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests".',
        "- Ensure the workflow/job also has `permissions: pull-requests: write` (and typically `contents: write`).",
        "",
        "GitHub API error: GitHub Actions is not permitted to create or approve pull requests.",
    ].join("\n");
}

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
    try {
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
    } catch (error) {
        if (isGitHubActionsPrCreationNotPermittedError(error)) {
            throw new Error(buildGitHubActionsPrCreationNotPermittedHelpMessage(), { cause: error });
        }
        throw error;
    }
}
