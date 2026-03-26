export type CursorAgentMessageContentItem = {
    readonly type?: string;
    readonly text?: string;
};

export type CursorAgentMessage = {
    readonly role?: string;
    readonly content?: readonly CursorAgentMessageContentItem[];
};

export type CursorAgentApiUsage = {
    readonly input_tokens?: number;
    readonly prompt_tokens?: number;
    readonly output_tokens?: number;
    readonly completion_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_read_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_creation_tokens?: number;
    readonly total_cost_usd?: number;
};

export type CursorAgentResultPayload = {
    readonly type?: string;
    readonly subtype?: string;
    readonly result?: string;
    readonly message?: string | CursorAgentMessage;
    readonly output?: string;
    readonly text?: string;
    readonly usage?: CursorAgentApiUsage;
    readonly total_cost_usd?: number;
};

export function toCursorAgentResultPayload(value: unknown): CursorAgentResultPayload {
    if (value !== null && typeof value === "object") {
        return value as CursorAgentResultPayload;
    }
    return {};
}

export function assistantTextFromUnknownMessage(message: unknown): string {
    if (message === undefined || message === null) {
        return "";
    }
    if (typeof message === "string") {
        return message;
    }
    if (typeof message === "object") {
        return assistantPlainTextFromCursorMessage(message as CursorAgentMessage);
    }
    return "";
}

export function assistantPlainTextFromCursorMessage(message: CursorAgentMessage): string {
    const content = message.content;
    if (content === undefined) {
        return "";
    }
    let out = "";
    for (const item of content) {
        const text = item.text;
        if (text !== undefined) {
            out += text;
        }
    }
    return out;
}

export function transcriptFromCursorAgentPayload(payload: CursorAgentResultPayload): string {
    const direct = payload.result;
    if (direct !== undefined && direct.length > 0) {
        return direct;
    }
    const messageField = payload.message;
    if (messageField !== undefined) {
        if (typeof messageField === "string") {
            return messageField;
        }
        const fromContent = assistantPlainTextFromCursorMessage(messageField);
        if (fromContent.length > 0) {
            return fromContent;
        }
    }
    const outputField = payload.output;
    if (outputField !== undefined) {
        return outputField;
    }
    const textField = payload.text;
    if (textField !== undefined) {
        return textField;
    }
    return "";
}
