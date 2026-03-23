import { defineCommand, runMain } from "citty";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import { commentMentionsJarvis, readIssueCommentEvent } from "./githubEvent.js";
import { writeGithubOutput } from "./githubOutput.js";
import { createOctokit, parseGithubRepository } from "./octokit.js";
import { hasRepoWriteAccess } from "./permissions.js";
import {
    nonPlanIntentBody,
    notifyFailure,
    notifyUnauthorized,
    postAutomationIssueComment,
} from "./comments.js";
import { runIntentClassification } from "./runIntent.js";
import { runPlanGeneration } from "./runPlan.js";
import { parseDiscussionKind, parseDiscussionNumber } from "./envUtils.js";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

type IssueCommentPreset = "unauthorized" | "non-plan" | "workflow-failed";

const threadGateCommand = defineCommand({
    meta: {
        name: "gate",
        description:
            "Read issue_comment from GITHUB_EVENT_PATH; emit discussion ids and whether the Jarvis gate passes.",
    },
    async run() {
        const eventPath = requireEnv("GITHUB_EVENT_PATH");
        const payload = readIssueCommentEvent(eventPath);
        const discussionNumber = payload.issue.number;
        const discussionKind: DiscussionKind =
            payload.issue.pull_request != null ? "pull_request" : "issue";
        const shouldContinue = commentMentionsJarvis(payload.comment.body);

        writeGithubOutput("discussion_number", String(discussionNumber));
        writeGithubOutput("discussion_kind", discussionKind);
        writeGithubOutput("should_continue", shouldContinue ? "true" : "false");
    },
});

const threadCommand = defineCommand({
    meta: {
        name: "thread",
        description: "Issue / PR comment thread (webhook-shaped) utilities.",
    },
    subCommands: {
        gate: threadGateCommand,
    },
});

const authAssertWriteCommand = defineCommand({
    meta: {
        name: "assert-write",
        description:
            "Require GITHUB_ACTOR to have repo write access; set GITHUB_OUTPUT authorized when in Actions.",
    },
    async run() {
        const octokit = createOctokit();
        const repo = parseGithubRepository(process.env.GITHUB_REPOSITORY);
        const actor = requireEnv("GITHUB_ACTOR");
        const authorized = await hasRepoWriteAccess(octokit, repo, actor);
        writeGithubOutput("authorized", authorized ? "true" : "false");
        const inActions = Boolean(process.env.GITHUB_OUTPUT);
        if (!inActions && !authorized) {
            process.exitCode = 1;
        }
    },
});

const authCommand = defineCommand({
    meta: {
        name: "auth",
        description: "Repository permission checks.",
    },
    subCommands: {
        "assert-write": authAssertWriteCommand,
    },
});

const branchPrintCommand = defineCommand({
    meta: {
        name: "print",
        description: "Print the deterministic ai/issue-N or ai/pr-N branch ref.",
    },
    args: {
        kind: {
            type: "enum",
            options: ["issue", "pull_request"] as const,
            description: "Discussion kind",
            required: true,
        },
        number: {
            type: "string",
            description: "Issue or PR number",
            required: true,
        },
    },
    async run({ args }) {
        const discussionNumber = parseDiscussionNumber(args.number);
        const kind = args.kind as DiscussionKind;
        process.stdout.write(`${buildPlanBranchRef({ kind, number: discussionNumber })}\n`);
    },
});

const branchCommand = defineCommand({
    meta: {
        name: "branch",
        description: "Naming for plan / implementation branches.",
    },
    subCommands: {
        print: branchPrintCommand,
    },
});

const classifyIntentCommand = defineCommand({
    meta: {
        name: "intent",
        description: "Classify latest comment intent via Jarvis agent CLI (intent-detector skill).",
    },
    async run() {
        const octokit = createOctokit();
        const repo = parseGithubRepository(process.env.GITHUB_REPOSITORY);
        const eventPath = requireEnv("GITHUB_EVENT_PATH");
        const discussionKind = parseDiscussionKind(process.env.DISCUSSION_KIND);
        const discussionNumber = parseDiscussionNumber(process.env.DISCUSSION_NUMBER);
        await runIntentClassification({
            octokit,
            repo,
            eventPath,
            discussionKind,
            discussionNumber,
        });
    },
});

const classifyCommand = defineCommand({
    meta: {
        name: "classify",
        description: "LLM-backed classification helpers.",
    },
    subCommands: {
        intent: classifyIntentCommand,
    },
});

const planGenerateCommand = defineCommand({
    meta: {
        name: "generate",
        description:
            "Create or update the plan branch, run the planner agent, push, and post thread comments.",
    },
    async run() {
        const octokit = createOctokit();
        const repo = parseGithubRepository(process.env.GITHUB_REPOSITORY);
        const discussionKind = parseDiscussionKind(process.env.DISCUSSION_KIND);
        const discussionNumber = parseDiscussionNumber(process.env.DISCUSSION_NUMBER);
        await runPlanGeneration({
            octokit,
            repo,
            discussionKind,
            discussionNumber,
        });
    },
});

const planCommand = defineCommand({
    meta: {
        name: "plan",
        description: "Implementation plan generation and branch updates.",
    },
    subCommands: {
        generate: planGenerateCommand,
    },
});

const issueCommentCommand = defineCommand({
    meta: {
        name: "comment",
        description: "Post a standard comment on the issue or PR thread (DISCUSSION_NUMBER).",
    },
    args: {
        preset: {
            type: "enum",
            options: ["unauthorized", "non-plan", "workflow-failed"] as const,
            description: "Comment template",
            required: true,
        },
    },
    async run({ args }) {
        const preset = args.preset as IssueCommentPreset;
        const octokit = createOctokit();
        const repo = parseGithubRepository(process.env.GITHUB_REPOSITORY);
        const discussionNumber = parseDiscussionNumber(process.env.DISCUSSION_NUMBER);

        switch (preset) {
            case "unauthorized": {
                await notifyUnauthorized(octokit, repo, discussionNumber);
                return;
            }
            case "non-plan": {
                const classifiedIntent = process.env.PLAN_INTENT ?? "";
                if (classifiedIntent === "none" || classifiedIntent === "") {
                    return;
                }
                await postAutomationIssueComment(
                    octokit,
                    repo,
                    discussionNumber,
                    nonPlanIntentBody(classifiedIntent),
                );
                return;
            }
            case "workflow-failed": {
                const server = requireEnv("GITHUB_SERVER_URL").replace(/\/$/, "");
                const repoSlug = requireEnv("GITHUB_REPOSITORY");
                const runId = requireEnv("GITHUB_RUN_ID");
                const runUrl = `${server}/${repoSlug}/actions/runs/${runId}`;
                await notifyFailure(octokit, repo, discussionNumber, runUrl);
                return;
            }
            default: {
                const exhaustive: never = preset;
                throw new Error(`Unhandled preset: ${String(exhaustive)}`);
            }
        }
    },
});

const issueCommand = defineCommand({
    meta: {
        name: "issue",
        description: "GitHub issue (and pull request as issue) helpers.",
    },
    subCommands: {
        comment: issueCommentCommand,
    },
});

const main = defineCommand({
    meta: {
        name: "github-plan",
        description:
            "Jarvis: GitHub threads, repo auth, branch naming, intent classification, and plan generation.",
    },
    subCommands: {
        thread: threadCommand,
        auth: authCommand,
        branch: branchCommand,
        classify: classifyCommand,
        plan: planCommand,
        issue: issueCommand,
    },
});

function cliRawArgs(): string[] {
    const raw = process.argv.slice(2);
    const scriptIdx = raw.findIndex((arg) => arg.endsWith("cli.ts") || arg.endsWith("cli.js"));
    return scriptIdx >= 0 ? raw.slice(scriptIdx + 1) : raw;
}

try {
    await runMain(main, { rawArgs: cliRawArgs() });
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
