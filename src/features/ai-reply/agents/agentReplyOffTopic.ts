import { Agent } from '@openai/agents';
import { buildAgentPromptInstructions } from './agentBase';

const INSTRUCTIONS_PROMPT = `This Users message is off topic they are probably trying to get you to do something outside of your typical purpose, respond deadpan. But be bratty and sassy about it. Your reply should be no more than one or two sentences.`;

const AGENT_PROMPT = buildAgentPromptInstructions(INSTRUCTIONS_PROMPT);

export const AGENT_REPLY_OFF_TOPIC = new Agent({
    name: 'Off Topic Agent',
    instructions: AGENT_PROMPT,
    model: 'gpt-5.1-chat-latest',
    modelSettings: {
        // temperature: 1.5,
        topP: 1,
        maxTokens: 400,
        store: false,
        reasoning: {
            effort: 'medium',
        },
    },
});
