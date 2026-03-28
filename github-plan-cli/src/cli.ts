import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    assembleThinkingFromStreamLog,
    formatCursorAgentStreamReportHuman,
    parseCursorAgentStreamLogFile,
} from "./agent/parseCursorAgentStreamLog.js";
import { defineCommand, runMain } from "citty";
import { parseDiscussionKind, parseDiscussionNumber, parseEnvBoolTrue } from "./config/parseGithubPlanEnv.js";
import {
    IMPLEMENT_NO_PLAN_BODY,
    nonPlanIntentBody,
    notifyFailure,
    notifyFailureImplement,
    notifyFailureIntentPhase,
    notifyUnauthorized,
    postAutomationIssueComment,
} from "./github/automationComments.js";
import { commentMentionsJarvis, readIssueCommentEvent } from "./github/issueCommentEvent.js";
import { githubActionsRunUrlFromEnv } from "./github/actionsRunUrl.js";
import { createOctokit, parseGithubRepository } from "./github/octokit.js";
import { hasRepoWriteAccess } from "./github/hasRepoWriteAccess.js";
import { writeGithubOutput } from "./github/writeGithubOutput.js";
import { runIntentClassification } from "./intent/runIntentClassification.js";
import { planIsFeedbackForGithubOutput, shouldTreatIntentAsPlanFeedback } from "./plan/planFeedback.js";
import { fetchPlanMarkdownFromBranch } from "./plan/fetchPlanMarkdownFromBranch.js";
import { buildPlanBranchRef, type DiscussionKind } from "./plan/planBranch.js";
import { runPlanGeneration } from "./plan/runPlanGeneration.js";
import { runPlanImplementation } from "./plan/runPlanImplementation.js";
import { runPlanLocal } from "./plan/runPlanLocal.js";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

type IssueCommentPreset =
    | "unauthorized"
    | "non-plan"
    | "workflow-failed"
    | "workflow-failed-intent"
    | "implement-no-plan"
    | "workflow-failed-implement";

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

        const { intent, runPlan } = await runIntentClassification({
            text: triggerCommentText,
            hasExistingPlan,
            discussionKind,
        });
        const semanticPlanFeedback = shouldTreatIntentAsPlanFeedback(intent, hasExistingPlan);
        const planIsFeedback = planIsFeedbackForGithubOutput(runPlan, semanticPlanFeedback);

        writeGithubOutput("intent", intent);
        writeGithubOutput("run_plan", runPlan ? "true" : "false");
        writeGithubOutput("plan_is_feedback", planIsFeedback ? "true" : "false");
        writeGithubOutput("has_existing_plan", hasExistingPlan ? "true" : "false");
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
            "Checkout plan branch, run Cursor implement orchestrator (generic-implementer), verify build, push, open/update PR.",
    },
    async run() {
        const octokit = createOctokit();
        const repo = parseGithubRepository(process.env.GITHUB_REPOSITORY);
        const discussionKind = parseDiscussionKind(process.env.DISCUSSION_KIND);
        const discussionNumber = parseDiscussionNumber(process.env.DISCUSSION_NUMBER);
        await runPlanImplementation({
            octokit,
            repo,
            discussionKind,
            discussionNumber,
        });
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
            options: [
                "unauthorized",
                "non-plan",
                "workflow-failed",
                "workflow-failed-intent",
                "implement-no-plan",
                "workflow-failed-implement",
            ] as const,
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
                await notifyFailure(
                    octokit,
                    repo,
                    discussionNumber,
                    githubActionsRunUrlFromEnv(),
                );
                return;
            }
            case "workflow-failed-intent": {
                await notifyFailureIntentPhase(
                    octokit,
                    repo,
                    discussionNumber,
                    githubActionsRunUrlFromEnv(),
                );
                return;
            }
            case "implement-no-plan": {
                await postAutomationIssueComment(octokit, repo, discussionNumber, IMPLEMENT_NO_PLAN_BODY);
                return;
            }
            case "workflow-failed-implement": {
                await notifyFailureImplement(
                    octokit,
                    repo,
                    discussionNumber,
                    githubActionsRunUrlFromEnv(),
                );
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

const agentParseStreamLogCommand = defineCommand({
    meta: {
        name: "parse-stream-log",
        description:
            "Summarize a Cursor agent NDJSON log (`--output-format stream-json`, often with `--stream-partial-output`).",
    },
    args: {
        file: {
            type: "string",
            description: "Path to the log file (one JSON object per line)",
            required: true,
        },
        json: {
            type: "boolean",
            description: "Print full structured report as JSON",
            default: false,
        },
        thinking: {
            type: "boolean",
            description: "Include per-block thinking stats (deltas merged until subtype completed)",
            default: false,
        },
    },
    async run({ args }) {
        const absolutePath = resolve(process.cwd(), args.file);
        const report = parseCursorAgentStreamLogFile(absolutePath);
        if (args.json) {
            const payload: Record<string, unknown> = { ...report };
            if (args.thinking) {
                const content = readFileSync(absolutePath, "utf8");
                payload.thinkingBlocks = assembleThinkingFromStreamLog(content);
            }
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
            return;
        }
        process.stdout.write(`${formatCursorAgentStreamReportHuman(report)}\n`);
        if (args.thinking) {
            const content = readFileSync(absolutePath, "utf8");
            const blocks = assembleThinkingFromStreamLog(content);
            process.stdout.write(`\nThinking blocks (delta → completed): ${String(blocks.length)}\n`);
            const previewLimit = 40;
            for (const block of blocks.slice(0, previewLimit)) {
                process.stdout.write(
                    `  session=${block.sessionId} block#=${String(block.blockIndex)} deltas=${String(block.deltaCount)} chars=${String(block.assembledChars)}\n`,
                );
            }
            if (blocks.length > previewLimit) {
                process.stdout.write(`  … ${String(blocks.length - previewLimit)} more\n`);
            }
        }
    },
});

const agentCommand = defineCommand({
    meta: {
        name: "agent",
        description: "Cursor agent log utilities (stream-json NDJSON).",
    },
    subCommands: {
        "parse-stream-log": agentParseStreamLogCommand,
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
        agent: agentCommand,
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
