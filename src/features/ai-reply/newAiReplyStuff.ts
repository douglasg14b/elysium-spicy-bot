import { OpenAI } from 'openai';
import { z } from 'zod';
import { Agent, AgentInputItem, Runner, withTrace } from '@openai/agents';
import { runAndApplyGuardrails } from './lib/oaiAgentGuardrails';
import { AGENT_OFF_TOPIC_DETECTOR, OffTopicDetectionResult } from './agents/agentOffTopicDetector';
import { AGENT_REPLY_OFF_TOPIC } from './agents/agentReplyOffTopic';
import { AGENT_REPLY_ON_TOPIC } from './agents/agentReplyOnTopic';
import { AGENT_REPLY_JAILBREAK } from './agents/agentReplyJailbreak';
import { AGENT_REPLY_MODERATION } from './agents/agentReplyModeration';
import { MessageContext } from './aiService';
import { AGENT_REPLY_ON_TOPIC_THREAD } from './agents/agentReplyOnTopicThread';
import { Message } from 'discord.js';

type WorkflowInput = {
    input_as_text: string;
    recentMessages: MessageContext[];
    isReplyToBot: boolean;
    referencedMessage?: MessageContext;
    sendTyping: () => Promise<void>;
};

type WorkflowResult = {
    output_text: string;
    wasModerationAbuse: boolean;
};

// Main code entrypoint
export async function runWorkflow(workflow: WorkflowInput, client: OpenAI): Promise<WorkflowResult> {
    console.log('[DEBUG] runWorkflow: Starting workflow execution');

    const { input_as_text, sendTyping } = workflow;

    return await withTrace('New agent', async () => {
        const conversationHistory: AgentInputItem[] = [
            { role: 'user', content: [{ type: 'input_text', text: workflow.input_as_text }] },
        ];

        const runner = new Runner({
            traceMetadata: {
                __trace_source__: 'agent-builder',
                workflow_id: 'wf_6962d81eb37c8190b1d8f4f90a05e7ff0ee4a236ddf30613',
            },
        });

        const guardrailsInputText = workflow.input_as_text;
        const {
            hasTripwire: guardrailsHasTripwire,
            safeText: guardrailsAnonymizedText,
            failOutput: guardrailsFailOutput,
            passOutput: guardrailsPassOutput,
        } = await runAndApplyGuardrails(guardrailsInputText, conversationHistory, workflow, client);
        void sendTyping();

        if (guardrailsHasTripwire) {
            if (guardrailsFailOutput.jailbreak?.failed) {
                const outputText = await generateJailbreakResponse(runner, guardrailsAnonymizedText);
                return {
                    output_text: outputText,
                    wasModerationAbuse: false,
                };
            }

            if (guardrailsFailOutput.moderation?.failed) {
                const outputText = await generateModerationResponse(runner, guardrailsAnonymizedText);
                return {
                    output_text: outputText,
                    wasModerationAbuse: true,
                };
            }
        }

        const isOnTopic = await checkIsOnTopic(runner, conversationHistory, guardrailsAnonymizedText);
        void sendTyping();

        if (!isOnTopic) {
            const outputText = await generateOffTopicResponse(runner, guardrailsAnonymizedText);
            return {
                output_text: outputText,
                wasModerationAbuse: false,
            };
        }

        const outputText = await generateOnTopicResponse({
            runner,
            conversationHistory,
            recentMessages: workflow.recentMessages,
            isReplyToBot: workflow.isReplyToBot,
            referencedMessage: workflow.referencedMessage,
        });
        return {
            output_text: outputText,
            wasModerationAbuse: false,
        };
    });
}

async function checkIsOnTopic(runner: Runner, conversationHistory: AgentInputItem[], userText: string) {
    const singleMessageConvo = [{ role: 'user', content: [{ type: 'input_text', text: userText }] }];

    const offTopicDetectionResultTemp = await runner.run(AGENT_OFF_TOPIC_DETECTOR, singleMessageConvo);

    if (!offTopicDetectionResultTemp.finalOutput) {
        throw new Error('Agent result is undefined');
    }

    offTopicDetectionResultTemp.finalOutput;

    const offTopicDetectionResult = {
        output_text: JSON.stringify(offTopicDetectionResultTemp.finalOutput),
        output_parsed: offTopicDetectionResultTemp.finalOutput,
    };

    const topicalResult = offTopicDetectionResultTemp.finalOutput as OffTopicDetectionResult;

    return topicalResult.topical === 'on_topic';
}

async function generateJailbreakResponse(runner: Runner, userText: string) {
    const singleMessageConvo = [{ role: 'user', content: [{ type: 'input_text', text: userText }] }];

    const jailbreakAgentResult = await runner.run(AGENT_REPLY_JAILBREAK, singleMessageConvo);

    if (!jailbreakAgentResult.finalOutput) {
        throw new Error('Agent result is undefined');
    }

    return jailbreakAgentResult.finalOutput;
}

async function generateModerationResponse(runner: Runner, userText: string) {
    const singleMessageConvo = [{ role: 'user', content: [{ type: 'input_text', text: userText }] }];

    const moderationAgentResult = await runner.run(AGENT_REPLY_MODERATION, singleMessageConvo);
    if (!moderationAgentResult.finalOutput) {
        console.log('[ERROR] generateModerationResponse: Agent result is undefined');
        throw new Error('Agent result is undefined');
    }

    return moderationAgentResult.finalOutput;
}

async function generateOffTopicResponse(runner: Runner, userText: string) {
    const singleMessageConvo = [{ role: 'user', content: [{ type: 'input_text', text: userText }] }];

    const offTopicAgentResultTemp = await runner.run(AGENT_REPLY_OFF_TOPIC, singleMessageConvo);

    if (!offTopicAgentResultTemp.finalOutput) {
        console.log('[ERROR] generateOffTopicResponse: Agent result is undefined');
        throw new Error('Agent result is undefined');
    }

    return offTopicAgentResultTemp.finalOutput;
}

type GenerateOnTopicResponseParams = {
    runner: Runner;
    conversationHistory: AgentInputItem[];
    recentMessages: MessageContext[];
    isReplyToBot: boolean;
    referencedMessage?: MessageContext;
};

async function generateOnTopicResponse({
    runner,
    conversationHistory,
    recentMessages,
    isReplyToBot,
    referencedMessage,
}: GenerateOnTopicResponseParams) {
    function genMessageContent(msg: MessageContext) {
        return `At ${msg.timestamp.toISOString()}, ${msg.author} said: "${msg.content}"${
            msg.isReply && msg.replyToAuthor ? ` in reply to ${msg.replyToAuthor}` : ''
        }${msg.isFromBot ? ' (this was a message from BrattyBot)' : ''}`;
    }

    const historicalMessagesHistory = recentMessages.map((msg) => {
        return {
            role: 'system',
            content: genMessageContent(msg),
            name: msg.author,
        };
    });

    if (referencedMessage) {
        historicalMessagesHistory.push({
            role: 'system',
            content: `The user just replied to this message in their most recent message: "${genMessageContent(
                referencedMessage
            )}"`,
            name: 'BrattyBot',
        });
    }

    const agent = referencedMessage ? AGENT_REPLY_ON_TOPIC : AGENT_REPLY_ON_TOPIC_THREAD;

    const onTopicAgentResultTemp = await runner.run(agent, [...historicalMessagesHistory, ...conversationHistory]);

    if (!onTopicAgentResultTemp.finalOutput) {
        throw new Error('Agent result is undefined');
    }

    return onTopicAgentResultTemp.finalOutput;
}
