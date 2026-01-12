import { OpenAI } from 'openai';
import { runGuardrails, GuardrailBundle, GuardrailResult } from '@openai/guardrails';

// ===============================================
// This is a bunch of craptastic code from OpenAI
// I've cleaned it up a bit but it's still pretty bad
// ===============================================

type GuardrailContext = {
    guardrailLlm: OpenAI;
};

interface MessageContent {
    type: string;
    text: string;
}

interface Message {
    content: MessageContent[] | string;
}

interface Workflow {
    input_as_text?: string;
    input_text?: string;
    [key: string]: unknown;
}

interface GuardrailFailOutput {
    pii: {
        failed: boolean;
        detected_counts: string[];
    };
    jailbreak: {
        failed: boolean;
    };
    moderation: {
        failed: boolean;
        flagged_categories?: string[];
    };
}

interface GuardrailRunResult {
    results: GuardrailResult[];
    hasTripwire: boolean;
    safeText: string;
    failOutput: GuardrailFailOutput;
    passOutput: {
        safe_text: string;
    };
}

// Guardrails definitions
const jailbreakGuardrailConfig = {
    guardrails: [
        { name: 'Jailbreak', config: { model: 'gpt-5-nano', confidence_threshold: 0.7 } },
        {
            name: 'Moderation',
            config: {
                categories: [
                    'sexual/minors',
                    'hate',
                    'hate/threatening',
                    'harassment',
                    'harassment/threatening',
                    'self-harm/instructions',
                    'violence/graphic',
                    'illicit/violent',
                ],
            },
        },
    ],
};

function guardrailsHasTripwire(results: GuardrailResult[]): boolean {
    if (!results || !results.length) return false;

    return results.some((r) => r?.tripwireTriggered === true);
}

function getGuardrailSafeText(results: GuardrailResult[], fallbackText: string): string {
    if (!results || !results.length) return fallbackText;

    for (const r of results) {
        if (!r || !r.info) continue;

        if ('checked_text' in r.info) {
            return r.info.checked_text ?? fallbackText;
        }
    }
    const pii = results.find((r) => r?.info && 'anonymized_text' in r.info);
    return (pii?.info?.anonymized_text as string | null) ?? fallbackText;
}

async function scrubConversationHistory(
    history: Message[],
    piiOnly: GuardrailBundle,
    context: GuardrailContext
): Promise<void> {
    if (!history || !Array.isArray(history)) return;

    for (const msg of history) {
        const content = Array.isArray(msg?.content) ? msg.content : [];
        for (const part of content) {
            if (part && typeof part === 'object' && part.type === 'input_text' && typeof part.text === 'string') {
                const res = await runGuardrails(part.text, piiOnly, context, true);
                part.text = getGuardrailSafeText(res, part.text);
            }
        }
    }
}

async function scrubWorkflowInput(
    workflow: Workflow,
    inputKey: string,
    piiOnly: GuardrailBundle,
    context: GuardrailContext
): Promise<void> {
    if (!workflow || typeof workflow !== 'object') return;

    const value = workflow?.[inputKey];
    if (typeof value !== 'string') return;

    const res = await runGuardrails(value, piiOnly, context, true);
    workflow[inputKey] = getGuardrailSafeText(res, value);
}

export async function runAndApplyGuardrails(
    inputText: string,
    history: Message[],
    workflow: Workflow,
    client: OpenAI
): Promise<GuardrailRunResult> {
    const config = jailbreakGuardrailConfig;
    const context: GuardrailContext = { guardrailLlm: client };

    const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];

    const results = await runGuardrails(inputText, config, context, true);
    const shouldMaskPII = guardrails.find(
        (g: { name?: string; config?: Record<string, unknown> }) =>
            g?.name === 'Contains PII' && g?.config && 'block' in g.config && g.config.block === false
    );
    if (shouldMaskPII) {
        const piiOnly: GuardrailBundle = { guardrails: [shouldMaskPII] };
        await scrubConversationHistory(history, piiOnly, context);
        await scrubWorkflowInput(workflow, 'input_as_text', piiOnly, context);
        await scrubWorkflowInput(workflow, 'input_text', piiOnly, context);
    }
    const hasTripwire = guardrailsHasTripwire(results);
    const safeText = getGuardrailSafeText(results, inputText) ?? inputText;
    return {
        results,
        hasTripwire,
        safeText,
        failOutput: buildGuardrailFailOutput(results ?? []),
        passOutput: { safe_text: safeText },
    };
}

export function buildGuardrailFailOutput(results: GuardrailResult[]): GuardrailFailOutput {
    const get = (name: string) =>
        (results ?? []).find((r: GuardrailResult) => (r?.info?.guardrail_name ?? r?.info?.guardrailName) === name);

    const pii = get('Contains PII');
    const jb = get('Jailbreak');
    const mod = get('Moderation');

    const piiCounts = Object.entries(pii?.info?.detected_entities ?? {})
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => k + ':' + (Array.isArray(v) ? v.length : 0));

    const moderation = {
        failed: mod?.tripwireTriggered === true || ((mod?.info?.flagged_categories as string[]) ?? []).length > 0,
        flagged_categories: mod?.info?.flagged_categories as string[],
    };

    return {
        pii: { failed: piiCounts.length > 0 || pii?.tripwireTriggered === true, detected_counts: piiCounts },
        jailbreak: { failed: jb?.tripwireTriggered === true },
        moderation,
    };
}
