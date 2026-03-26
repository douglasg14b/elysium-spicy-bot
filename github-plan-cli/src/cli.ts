import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { parseDiscussionKind, parseDiscussionNumber, parseEnvBoolTrue } from "./config/parseGithubPlanEnv.js";
import {
    nonPlanIntentBody,
    notifyFailure,
    notifyUnauthorized,
    postAutomationIssueComment,
} from "./github/automationComments.js";
import { commentMentionsJarvis, readIssueCommentEvent } from "./github/issueCommentEvent.js";
import { createOctokit, parseGithubRepository } from "./github/octokit.js";
import { hasRepoWriteAccess } from "./github/hasRepoWriteAccess.js";
import { writeGithubOutput } from "./github/writeGithubOutput.js";
import { runIntentClassification } from "./intent/runIntentClassification.js";
import { runImplementPlanStub } from "./plan/implementPlanStub.js";
import { planIsFeedbackForGithubOutput, shouldTreatIntentAsPlanFeedback } from "./plan/planFeedback.js";
import { fetchPlanMarkdownFromBranch } from "./plan/fetchPlanMarkdownFromBranch.js";
import { buildPlanBranchRef, type DiscussionKind } from "./plan/planBranch.js";
import { runPlanGeneration } from "./plan/runPlanGeneration.js";
import { runPlanLocal } from "./plan/runPlanLocal.js";

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
        description: "Classify the triggering issue_comment body for plan automation (OpenAI Agents).",
    },
    async run() {
        const octokit = createOctokit();
        const repo = parseGithubRepository(process.env.GITHUB_REPOSITORY);
        const eventPath = requireEnv("GITHUB_EVENT_PATH");
        const discussionKind = parseDiscussionKind(process.env.DISCUSSION_KIND);
        const discussionNumber = parseDiscussionNumber(process.env.DISCUSSION_NUMBER);

        const payload = readIssueCommentEvent(eventPath);
        const triggerCommentText = payload.comment.body ?? "";

        const branchRef = buildPlanBranchRef({ kind: discussionKind, number: discussionNumber });
        const planFromBranch = await fetchPlanMarkdownFromBranch(octokit, repo, branchRef);
        const hasExistingPlan = planFromBranch != null && planFromBranch.trim() !== "";

        const { intent, runPlan } = await runIntentClassification({ text: triggerCommentText });
        const semanticPlanFeedback = shouldTreatIntentAsPlanFeedback(intent, hasExistingPlan);
        const planIsFeedback = planIsFeedbackForGithubOutput(runPlan, semanticPlanFeedback);

        writeGithubOutput("intent", intent);
        writeGithubOutput("run_plan", runPlan ? "true" : "false");
        writeGithubOutput("plan_is_feedback", planIsFeedback ? "true" : "false");
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
        const isPlanFeedbackRun = parseEnvBoolTrue(process.env.PLAN_IS_FEEDBACK);
        await runPlanGeneration({
            octokit,
            repo,
            discussionKind,
            discussionNumber,
            isPlanFeedbackRun,
        });
    },
});

const planImplementCommand = defineCommand({
    meta: {
        name: "implement",
        description:
            "Reserved: run implementation from plan (not automated yet — see github-plan-cli/FUTURE-IMPLEMENT.md).",
    },
    async run() {
        await runImplementPlanStub();
    },
});

const planRunLocalCommand = defineCommand({
    meta: {
        name: "run-local",
        description:
            "Run the Cursor planner from a local markdown file or stdin (no GitHub token). Writes .jarvis/plan.md.",
    },
    args: {
        stdin: {
            type: "boolean",
            description: "Read context markdown from stdin",
            default: false,
        },
        revise: {
            type: "boolean",
            description: "Use planner-revise.md (expects existing .jarvis/plan.md)",
            default: false,
        },
        file: {
            type: "string",
            description: "Path to context markdown (required unless --stdin)",
        },
    },
    async run({ args }) {
        const useStdin = Boolean(args.stdin);
        const filePath = args.file?.trim() ?? "";
        if (useStdin && filePath !== "") {
            throw new Error("Use either --stdin or --file, not both.");
        }
        if (!useStdin && filePath === "") {
            throw new Error("Provide --file <path> to a markdown file or use --stdin.");
        }
        const contextMarkdown = useStdin
            ? readFileSync(0, "utf8")
            : readFileSync(resolve(process.cwd(), filePath), "utf8");
        const { planPath } = await runPlanLocal({
            contextMarkdown,
            isPlanFeedbackRun: Boolean(args.revise),
        });
        process.stdout.write(`${planPath}\n`);
    },
});

const planCommand = defineCommand({
    meta: {
        name: "plan",
        description: "Implementation plan generation and branch updates.",
    },
    subCommands: {
        generate: planGenerateCommand,
        implement: planImplementCommand,
        "run-local": planRunLocalCommand,
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
