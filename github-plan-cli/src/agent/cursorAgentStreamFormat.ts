import { assistantTextFromUnknownMessage } from './cursorAgentJsonTypes.js';
import { envValueIsTruthy } from '../config/envTruthy.js';
import { isPlanCliDebugEnabled, planDebugLog, truncateForPlanDebug } from '../plan/planDebug.js';

const ASSISTANT_PREVIEW_CHARS = 200;
const CWD_PREVIEW_CHARS = 96;
const VERBOSE_JSON_MAX_CHARS = 8_000;
const VERBOSE_RESULT_TEXT_MAX = 400;
const VERBOSE_ASSISTANT_CHUNK_MAX = 120;
const VERBOSE_FUNCTION_ARGS_MAX = 400;

/**
 * When set together with plan debug, logs each stream event as JSON (truncated; sensitive fields redacted).
 */
export function isGithubPlanAgentStreamVerboseEnabled(): boolean {
    return envValueIsTruthy(process.env.GITHUB_PLAN_AGENT_STREAM_VERBOSE);
}

export type NdjsonBufferState = {
    remainder: string;
};

export function createNdjsonBufferState(): NdjsonBufferState {
    return { remainder: '' };
}

/**
 * Split incoming stdout into complete NDJSON lines. Updates `state.remainder` with an incomplete trailing fragment.
 * Returned lines do not include the newline delimiter.
 *
 * **Contract:** Cursor `agent --output-format stream-json` emits **one JSON object per line** (see Cursor CLI output-format docs).
 * Pretty-printed multi-line events are not supported; fragments would log as skipped lines.
 */
export function appendNdjsonChunks(state: NdjsonBufferState, chunk: string): string[] {
    const combined = state.remainder + chunk;
    const parts = combined.split(/\r?\n/);
    state.remainder = parts.pop() ?? '';
    return parts.map(stripCarriageReturn).filter((line) => line.length > 0);
}

function stripCarriageReturn(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function extractAssistantText(record: Record<string, unknown>): string {
    return assistantTextFromUnknownMessage(record.message);
}

function unwrapToolSuccessRecord(resultUnknown: unknown): Record<string, unknown> | undefined {
    if (resultUnknown === null || typeof resultUnknown !== 'object') {
        return undefined;
    }
    const resultRecord = resultUnknown as { success?: unknown };
    const successUnknown = resultRecord.success;
    if (successUnknown === null || typeof successUnknown !== 'object') {
        return undefined;
    }
    return successUnknown as Record<string, unknown>;
}

function summarizeReadToolResult(resultUnknown: unknown): string {
    const successRecord = unwrapToolSuccessRecord(resultUnknown);
    if (successRecord === undefined) {
        return '';
    }
    const lines = successRecord.totalLines;
    const chars = successRecord.totalChars;
    const empty = successRecord.isEmpty;
    return `[lines=${String(lines ?? '?')} chars=${String(chars ?? '?')} empty=${String(empty ?? '?')}]`;
}

function summarizeWriteToolResult(resultUnknown: unknown): string {
    const successRecord = unwrapToolSuccessRecord(resultUnknown);
    if (successRecord === undefined) {
        return '';
    }
    const linesCreated = successRecord.linesCreated;
    const fileSize = successRecord.fileSize;
    return `[linesCreated=${String(linesCreated ?? '?')} fileSize=${String(fileSize ?? '?')}]`;
}

function formatToolCallLine(record: Record<string, unknown>): string {
    const subtype = String(record.subtype ?? '');
    const toolCallUnknown = record.tool_call;
    if (toolCallUnknown === null || typeof toolCallUnknown !== 'object') {
        return `tool_call | ${subtype}`;
    }
    const toolCall = toolCallUnknown as Record<string, unknown>;

    const readTool = toolCall.readToolCall as Record<string, unknown> | undefined;
    if (readTool !== undefined) {
        const argsUnknown = readTool.args;
        const args =
            argsUnknown !== null && typeof argsUnknown === 'object' ? (argsUnknown as Record<string, unknown>) : {};
        const path = args.path !== undefined ? String(args.path) : '?';
        if (subtype === 'started') {
            return `tool read started | ${path}`;
        }
        return `tool read completed | ${path} ${summarizeReadToolResult(readTool.result)}`;
    }

    const writeTool = toolCall.writeToolCall as Record<string, unknown> | undefined;
    if (writeTool !== undefined) {
        const argsUnknown = writeTool.args;
        const args =
            argsUnknown !== null && typeof argsUnknown === 'object' ? (argsUnknown as Record<string, unknown>) : {};
        const path = args.path !== undefined ? String(args.path) : '?';
        if (subtype === 'started') {
            return `tool write started | ${path}`;
        }
        return `tool write completed | ${path} ${summarizeWriteToolResult(writeTool.result)}`;
    }

    const functionTool = toolCall.function as Record<string, unknown> | undefined;
    if (functionTool !== undefined) {
        const name = functionTool.name !== undefined ? String(functionTool.name) : '?';
        return `tool function | ${subtype} | ${name}`;
    }

    return `tool_call | ${subtype} | (unknown tool shape)`;
}

/**
 * Single-line human summary for stderr. Omits large payloads (file bodies, full prompts).
 */
export function formatCursorAgentStreamEventForLog(record: Record<string, unknown>): string {
    const type = record.type;
    if (type === 'system' && record.subtype === 'init') {
        const model = String(record.model ?? '');
        const cwd = truncateForPlanDebug(String(record.cwd ?? ''), CWD_PREVIEW_CHARS);
        const sessionId = String(record.session_id ?? '');
        const sessionShort = sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
        return `system init | model=${model} cwd=${cwd} session=${sessionShort}`;
    }
    if (type === 'user') {
        return 'user message (content omitted)';
    }
    if (type === 'assistant') {
        const text = extractAssistantText(record);
        if (text === '') {
            return 'assistant | (no text)';
        }
        return `assistant | ${truncateForPlanDebug(text, ASSISTANT_PREVIEW_CHARS)}`;
    }
    if (type === 'tool_call') {
        return formatToolCallLine(record);
    }
    if (type === 'result') {
        const durationMs = record.duration_ms;
        return `result | duration_ms=${String(durationMs ?? '?')}`;
    }
    return `event | type=${String(type ?? '?')}`;
}

function redactMessageForVerbose(messageUnknown: unknown): unknown {
    if (messageUnknown === null || typeof messageUnknown !== 'object') {
        return messageUnknown;
    }
    const messageRecord = { ...(messageUnknown as Record<string, unknown>) };
    const content = messageRecord.content;
    if (!Array.isArray(content)) {
        return messageRecord;
    }
    messageRecord.content = content.map((item) => {
        if (item !== null && typeof item === 'object' && 'text' in item) {
            const text = String((item as { text?: unknown }).text ?? '');
            return {
                ...(item as Record<string, unknown>),
                text: truncateForPlanDebug(text, VERBOSE_ASSISTANT_CHUNK_MAX),
            };
        }
        return item;
    });
    return messageRecord;
}

function redactReadToolForVerbose(readTool: Record<string, unknown>): Record<string, unknown> {
    const readRecord = { ...readTool };
    if (readRecord.result !== null && typeof readRecord.result === 'object') {
        const resultRecord = { ...(readRecord.result as Record<string, unknown>) };
        const successUnknown = resultRecord.success;
        if (successUnknown !== null && typeof successUnknown === 'object') {
            const successRecord = { ...(successUnknown as Record<string, unknown>) };
            if (typeof successRecord.content === 'string') {
                const length = successRecord.content.length;
                successRecord.content = `[redacted, ${String(length)} chars]`;
            }
            resultRecord.success = successRecord;
        }
        readRecord.result = resultRecord;
    }
    return readRecord;
}

function redactWriteToolForVerbose(writeTool: Record<string, unknown>): Record<string, unknown> {
    const writeRecord = { ...writeTool };
    const argsUnknown = writeRecord.args;
    if (argsUnknown !== null && typeof argsUnknown === 'object') {
        const argsRecord = { ...(argsUnknown as Record<string, unknown>) };
        if (typeof argsRecord.fileText === 'string') {
            argsRecord.fileText = `[redacted file body, ${String(argsRecord.fileText.length)} chars]`;
        }
        writeRecord.args = argsRecord;
    }
    return writeRecord;
}

function redactToolCallForVerbose(toolCallUnknown: unknown): unknown {
    if (toolCallUnknown === null || typeof toolCallUnknown !== 'object') {
        return toolCallUnknown;
    }
    const toolCall = { ...(toolCallUnknown as Record<string, unknown>) };
    const readTool = toolCall.readToolCall;
    if (readTool !== null && typeof readTool === 'object') {
        toolCall.readToolCall = redactReadToolForVerbose(readTool as Record<string, unknown>);
    }
    const writeTool = toolCall.writeToolCall;
    if (writeTool !== null && typeof writeTool === 'object') {
        toolCall.writeToolCall = redactWriteToolForVerbose(writeTool as Record<string, unknown>);
    }
    const functionTool = toolCall.function;
    if (functionTool !== null && typeof functionTool === 'object') {
        const fnRecord = { ...(functionTool as Record<string, unknown>) };
        const argsUnknown = fnRecord.arguments;
        if (typeof argsUnknown === 'string') {
            fnRecord.arguments = truncateForPlanDebug(argsUnknown, VERBOSE_FUNCTION_ARGS_MAX);
        } else if (argsUnknown !== undefined) {
            fnRecord.arguments = '[redacted]';
        }
        toolCall.function = fnRecord;
    }
    return toolCall;
}

/** Strip sensitive fields before verbose JSON logging (stderr may end up in CI artifacts). */
export function redactCursorAgentStreamEventForVerboseLog(record: Record<string, unknown>): Record<string, unknown> {
    const type = record.type;
    const clone: Record<string, unknown> = { ...record };
    if (type === 'user') {
        clone.message = '[redacted user message]';
        return clone;
    }
    if (type === 'assistant') {
        clone.message = redactMessageForVerbose(record.message);
        return clone;
    }
    if (type === 'tool_call') {
        clone.tool_call = redactToolCallForVerbose(record.tool_call);
        return clone;
    }
    if (type === 'system') {
        if (typeof clone.cwd === 'string') {
            clone.cwd = truncateForPlanDebug(clone.cwd, CWD_PREVIEW_CHARS);
        }
        return clone;
    }
    if (type === 'result') {
        const resultUnknown = record.result;
        if (typeof resultUnknown === 'string') {
            clone.result = truncateForPlanDebug(resultUnknown, VERBOSE_RESULT_TEXT_MAX);
        } else if (resultUnknown !== undefined) {
            clone.result = '[redacted non-string result]';
        }
        return clone;
    }
    return { type: record.type, subtype: record.subtype, session_id: record.session_id };
}

export function logCursorAgentStreamEvent(record: Record<string, unknown>): void {
    if (!isPlanCliDebugEnabled()) {
        return;
    }
    if (isGithubPlanAgentStreamVerboseEnabled()) {
        const safe = redactCursorAgentStreamEventForVerboseLog(record);
        const raw = JSON.stringify(safe);
        const payload =
            raw.length > VERBOSE_JSON_MAX_CHARS ? `${raw.slice(0, VERBOSE_JSON_MAX_CHARS)}… [truncated]` : raw;
        console.error(`[github-plan:agent:verbose] ${payload}`);
        return;
    }
    console.error(`[github-plan:agent] ${formatCursorAgentStreamEventForLog(record)}`);
}

export type HandleNdjsonLineResult = {
    /** Latest terminal `type: result` object seen on this line, if any. */
    terminalResult: Record<string, unknown> | undefined;
};

/** Parses one NDJSON line; optionally logs the event to stderr. */
export function handleNdjsonLine(line: string, emitStreamDebugLog: boolean): HandleNdjsonLineResult {
    try {
        const record = JSON.parse(stripCarriageReturn(line)) as Record<string, unknown>;
        if (emitStreamDebugLog && isPlanCliDebugEnabled()) {
            console.log(stripCarriageReturn(line));
            // logCursorAgentStreamEvent(record);
        }
        const isResult = record.type === 'result';
        return { terminalResult: isResult ? record : undefined };
    } catch {
        if (isPlanCliDebugEnabled()) {
            planDebugLog('agent stdout: non-JSON line skipped', {
                preview: truncateForPlanDebug(line, 200),
            });
        }
        return { terminalResult: undefined };
    }
}

/**
 * Flush a trailing buffer fragment after the stream closes (may be a final JSON line without newline).
 */
export function flushNdjsonRemainder(remainder: string, emitStreamDebugLog: boolean): HandleNdjsonLineResult {
    const normalized = stripCarriageReturn(remainder).trim();
    if (normalized === '') {
        return { terminalResult: undefined };
    }
    return handleNdjsonLine(normalized, emitStreamDebugLog);
}

/** Replays NDJSON stdout; returns the last `type: "result"` record. */
export function extractLastTerminalResultFromNdjsonStdout(
    stdout: string,
    emitStreamDebugLog: boolean,
): Record<string, unknown> | undefined {
    const state = createNdjsonBufferState();
    let lastTerminal: Record<string, unknown> | undefined;
    for (const line of appendNdjsonChunks(state, stdout)) {
        const { terminalResult } = handleNdjsonLine(line, emitStreamDebugLog);
        if (terminalResult !== undefined) {
            lastTerminal = terminalResult;
        }
    }
    const flushed = flushNdjsonRemainder(state.remainder, emitStreamDebugLog);
    if (flushed.terminalResult !== undefined) {
        lastTerminal = flushed.terminalResult;
    }
    return lastTerminal;
}
