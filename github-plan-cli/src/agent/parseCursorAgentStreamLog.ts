import { readFileSync } from "node:fs";

/** One NDJSON line from `agent --print --output-format stream-json` (and similar). */
export type CursorAgentStreamRecord = Record<string, unknown>;

export type CursorAgentStreamParseFailure = {
    readonly lineNumber: number;
    readonly preview: string;
};

export type ShellRejectedEvent = {
    readonly lineNumber: number;
    readonly callId: string;
    readonly command: string;
    readonly reason: string;
    readonly workingDirectory: string;
};

export type ToolCallSummary = {
    readonly started: number;
    readonly completed: number;
    readonly byKind: Record<string, { readonly started: number; readonly completed: number }>;
};

export type ResultLineSummary = {
    readonly lineNumber: number;
    readonly subtype: string | undefined;
    readonly isError: boolean;
    readonly durationMs: number | undefined;
    readonly resultPreview: string;
};

export type ThinkingAssemblyNote = {
    readonly sessionId: string;
    readonly blockIndex: number;
    readonly deltaCount: number;
    readonly assembledChars: number;
};

export type CursorAgentStreamParseReport = {
    readonly lineCount: number;
    readonly parsedRecordCount: number;
    readonly parseFailures: readonly CursorAgentStreamParseFailure[];
    readonly countsByType: Readonly<Record<string, number>>;
    readonly countsByThinkingSubtype: Readonly<Record<string, number>>;
    readonly countsByToolCallSubtype: Readonly<Record<string, number>>;
    readonly toolCalls: ToolCallSummary;
    readonly shellRejected: readonly ShellRejectedEvent[];
    readonly results: readonly ResultLineSummary[];
    readonly sessionIds: readonly string[];
    /** Why logs use `thinking.subtype === "delta"` instead of one full message per thought. */
    readonly streamSemanticsNote: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function toolKindFromToolCall(toolCallUnknown: unknown): string {
    if (!isRecord(toolCallUnknown)) {
        return "unknown";
    }
    if (toolCallUnknown.readToolCall !== undefined) {
        return "read";
    }
    if (toolCallUnknown.writeToolCall !== undefined) {
        return "write";
    }
    if (toolCallUnknown.editToolCall !== undefined) {
        return "edit";
    }
    if (toolCallUnknown.shellToolCall !== undefined) {
        return "shell";
    }
    if (toolCallUnknown.grepToolCall !== undefined) {
        return "grep";
    }
    if (toolCallUnknown.globToolCall !== undefined) {
        return "glob";
    }
    if (toolCallUnknown.taskToolCall !== undefined) {
        return "task";
    }
    if (toolCallUnknown.readLintsToolCall !== undefined) {
        return "readLints";
    }
    if (toolCallUnknown.function !== undefined) {
        return "function";
    }
    return "unknown";
}

function bumpKind(map: Record<string, { started: number; completed: number }>, kind: string, field: "started" | "completed"): void {
    const existing = map[kind] ?? { started: 0, completed: 0 };
    map[kind] = {
        started: existing.started + (field === "started" ? 1 : 0),
        completed: existing.completed + (field === "completed" ? 1 : 0),
    };
}

function extractShellRejected(lineNumber: number, record: Record<string, unknown>): ShellRejectedEvent | undefined {
    const toolCallUnknown = record.tool_call;
    if (!isRecord(toolCallUnknown)) {
        return undefined;
    }
    const shell = toolCallUnknown.shellToolCall;
    if (!isRecord(shell)) {
        return undefined;
    }
    const resultUnknown = shell.result;
    if (!isRecord(resultUnknown)) {
        return undefined;
    }
    const rejected = resultUnknown.rejected;
    if (!isRecord(rejected)) {
        return undefined;
    }
    const command = typeof rejected.command === "string" ? rejected.command : "";
    const reason = typeof rejected.reason === "string" ? rejected.reason : "";
    const workingDirectory = typeof rejected.workingDirectory === "string" ? rejected.workingDirectory : "";
    const callId = typeof record.call_id === "string" ? record.call_id : "";
    return { lineNumber, callId, command, reason, workingDirectory };
}

function summarizeResultLine(lineNumber: number, record: Record<string, unknown>): ResultLineSummary | undefined {
    if (record.type !== "result") {
        return undefined;
    }
    const subtype = stringField(record, "subtype");
    const isError = record.is_error === true;
    const durationMs =
        typeof record.duration_ms === "number"
            ? record.duration_ms
            : typeof record.duration_api_ms === "number"
              ? record.duration_api_ms
              : undefined;
    const resultText = typeof record.result === "string" ? record.result : "";
    const preview =
        resultText.length > 400 ? `${resultText.slice(0, 400)}… [truncated ${String(resultText.length)} chars]` : resultText;
    return { lineNumber, subtype, isError, durationMs, resultPreview: preview };
}

/**
 * Parse a full agent stream log (one JSON object per line).
 * Empty lines are skipped; malformed JSON is recorded in `parseFailures`.
 */
export function parseCursorAgentStreamLog(content: string): CursorAgentStreamParseReport {
    const lines = content.split(/\r?\n/);
    const parseFailures: CursorAgentStreamParseFailure[] = [];
    const countsByType: Record<string, number> = {};
    const countsByThinkingSubtype: Record<string, number> = {};
    const countsByToolCallSubtype: Record<string, number> = {};
    const byKind: Record<string, { started: number; completed: number }> = {};
    let toolStarted = 0;
    let toolCompleted = 0;
    const shellRejected: ShellRejectedEvent[] = [];
    const results: ResultLineSummary[] = [];
    const sessionSet = new Set<string>();
    let parsedRecordCount = 0;

    for (let index = 0; index < lines.length; index++) {
        const lineNumber = index + 1;
        const trimmed = lines[index]?.trim() ?? "";
        if (trimmed === "") {
            continue;
        }
        let record: unknown;
        try {
            record = JSON.parse(trimmed) as unknown;
        } catch {
            parseFailures.push({
                lineNumber,
                preview: trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed,
            });
            continue;
        }
        if (!isRecord(record)) {
            parseFailures.push({ lineNumber, preview: "(non-object JSON value)" });
            continue;
        }
        parsedRecordCount += 1;

        const typeField = stringField(record, "type") ?? "(missing type)";
        countsByType[typeField] = (countsByType[typeField] ?? 0) + 1;

        const sessionId = stringField(record, "session_id");
        if (sessionId !== undefined) {
            sessionSet.add(sessionId);
        }

        if (typeField === "thinking") {
            const st = stringField(record, "subtype") ?? "(missing subtype)";
            countsByThinkingSubtype[st] = (countsByThinkingSubtype[st] ?? 0) + 1;
        }

        if (typeField === "tool_call") {
            const sub = stringField(record, "subtype") ?? "(missing subtype)";
            countsByToolCallSubtype[sub] = (countsByToolCallSubtype[sub] ?? 0) + 1;
            const toolCallUnknown = record.tool_call;
            const kind = toolKindFromToolCall(toolCallUnknown);
            if (sub === "started") {
                toolStarted += 1;
                bumpKind(byKind, kind, "started");
            } else if (sub === "completed") {
                toolCompleted += 1;
                bumpKind(byKind, kind, "completed");
                const rejected = extractShellRejected(lineNumber, record);
                if (rejected !== undefined) {
                    shellRejected.push(rejected);
                }
            }
        }

        const resultSummary = summarizeResultLine(lineNumber, record);
        if (resultSummary !== undefined) {
            results.push(resultSummary);
        }
    }

    const streamSemanticsNote =
        "Cursor `agent` with `--output-format stream-json` (and especially `--stream-partial-output`) streams tokens as they are generated. " +
        "That is why you see many `thinking` events with `subtype: \"delta\"` (small `text` chunks) instead of a single full reasoning message per step. " +
        "Assistant `message` rows can also arrive in multiple partial chunks for the same reason. " +
        "To reconstruct full text, concatenate all `delta.text` in order until the next `thinking` `subtype: \"completed\"` (and merge assistant fragments by `model_call_id` / order).";

    return {
        lineCount: lines.length,
        parsedRecordCount,
        parseFailures,
        countsByType,
        countsByThinkingSubtype,
        countsByToolCallSubtype,
        toolCalls: {
            started: toolStarted,
            completed: toolCompleted,
            byKind: byKind,
        },
        shellRejected,
        results,
        sessionIds: [...sessionSet].sort(),
        streamSemanticsNote,
    };
}

export function parseCursorAgentStreamLogFile(absolutePath: string): CursorAgentStreamParseReport {
    const content = readFileSync(absolutePath, "utf8");
    return parseCursorAgentStreamLog(content);
}

function formatCountMap(title: string, map: Readonly<Record<string, number>>): string {
    const keys = Object.keys(map).sort((a, b) => map[b]! - map[a]!);
    if (keys.length === 0) {
        return `${title}: (none)\n`;
    }
    const lines = keys.map((key) => `  ${key}: ${String(map[key])}`);
    return `${title}:\n${lines.join("\n")}\n`;
}

/** Plain-text summary for terminal use. */
export function formatCursorAgentStreamReportHuman(report: CursorAgentStreamParseReport): string {
    const chunks: string[] = [];
    chunks.push(`Lines in file: ${String(report.lineCount)}`);
    chunks.push(`Parsed JSON records: ${String(report.parsedRecordCount)}`);
    chunks.push(`Parse failures: ${String(report.parseFailures.length)}`);
    chunks.push(`Distinct session_id: ${String(report.sessionIds.length)}`);
    chunks.push("");
    chunks.push(formatCountMap("Events by type", report.countsByType));
    chunks.push(formatCountMap("Thinking by subtype", report.countsByThinkingSubtype));
    chunks.push(formatCountMap("Tool_call by subtype", report.countsByToolCallSubtype));
    chunks.push(
        `Tool calls: started=${String(report.toolCalls.started)} completed=${String(report.toolCalls.completed)}`,
    );
    const kindKeys = Object.keys(report.toolCalls.byKind).sort();
    for (const kind of kindKeys) {
        const row = report.toolCalls.byKind[kind];
        if (row === undefined) {
            continue;
        }
        chunks.push(`  ${kind}: started=${String(row.started)} completed=${String(row.completed)}`);
    }
    chunks.push("");
    chunks.push(`Shell rejected: ${String(report.shellRejected.length)}`);
    for (const event of report.shellRejected.slice(0, 50)) {
        chunks.push(`  L${String(event.lineNumber)} call_id=${event.callId}`);
        chunks.push(`    command: ${event.command}`);
        if (event.reason.trim() !== "") {
            chunks.push(`    reason: ${event.reason}`);
        }
    }
    if (report.shellRejected.length > 50) {
        chunks.push(`  … ${String(report.shellRejected.length - 50)} more`);
    }
    chunks.push("");
    chunks.push(`Result lines: ${String(report.results.length)}`);
    for (const result of report.results) {
        chunks.push(
            `  L${String(result.lineNumber)} subtype=${String(result.subtype)} is_error=${String(result.isError)} duration_ms=${String(result.durationMs ?? "")}`,
        );
        if (result.resultPreview.trim() !== "") {
            const oneLine = result.resultPreview.replace(/\s+/g, " ").trim();
            chunks.push(`    ${oneLine}`);
        }
    }
    chunks.push("");
    chunks.push("Why deltas instead of full messages?");
    chunks.push(report.streamSemanticsNote);
    return chunks.join("\n");
}

type ThinkingBufferState = {
    blockIndex: number;
    text: string;
    deltaCount: number;
};

/**
 * Summarize `thinking` blocks: each run of `delta` events ends at `subtype: "completed"`.
 * Useful for seeing how many streaming chunks composed each thought without dumping full text.
 */
export function assembleThinkingFromStreamLog(content: string): readonly ThinkingAssemblyNote[] {
    const lines = content.split(/\r?\n/);
    const notes: ThinkingAssemblyNote[] = [];
    const buffers = new Map<string, ThinkingBufferState>();

    const bufferFor = (sessionId: string): ThinkingBufferState => {
        const existing = buffers.get(sessionId);
        if (existing !== undefined) {
            return existing;
        }
        const initial: ThinkingBufferState = { blockIndex: 0, text: "", deltaCount: 0 };
        buffers.set(sessionId, initial);
        return initial;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") {
            continue;
        }
        let record: unknown;
        try {
            record = JSON.parse(trimmed) as unknown;
        } catch {
            continue;
        }
        if (!isRecord(record) || record.type !== "thinking") {
            continue;
        }
        const sessionId = stringField(record, "session_id") ?? "";
        const subtype = stringField(record, "subtype");
        const text = typeof record.text === "string" ? record.text : "";
        const state = bufferFor(sessionId);

        if (subtype === "delta") {
            state.text += text;
            state.deltaCount += 1;
            buffers.set(sessionId, state);
        } else if (subtype === "completed") {
            if (state.deltaCount > 0) {
                notes.push({
                    sessionId,
                    blockIndex: state.blockIndex,
                    deltaCount: state.deltaCount,
                    assembledChars: state.text.length,
                });
            }
            buffers.set(sessionId, {
                blockIndex: state.blockIndex + 1,
                text: "",
                deltaCount: 0,
            });
        }
    }

    return notes;
}
