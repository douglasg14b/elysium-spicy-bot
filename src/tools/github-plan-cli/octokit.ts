import { Octokit } from "@octokit/rest";

export type RepoIdentity = { owner: string; repo: string };

export function parseGithubRepository(envRepo: string | undefined): RepoIdentity {
    const r = envRepo ?? process.env.GITHUB_REPOSITORY;
    if (!r || !r.includes("/")) {
        throw new Error("GITHUB_REPOSITORY must be set (owner/repo).");
    }
    const [owner, repo] = r.split("/", 2);
    if (!owner || !repo) throw new Error("Invalid GITHUB_REPOSITORY.");
    return { owner, repo };
}

export function createOctokit(): Octokit {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN must be set.");
    }
    return new Octokit({ auth: token });
}
