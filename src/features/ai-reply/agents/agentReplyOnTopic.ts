import { Agent } from '@openai/agents';
import { buildAgentPromptInstructions } from './agentBase';

const INSTRUCTIONS_PROMPT = `The users chat is on topic, reply in turn. Your reply should be no more than two or three sentences.`;

const AGENT_PROMPT = buildAgentPromptInstructions(INSTRUCTIONS_PROMPT);

export const AGENT_REPLY_ON_TOPIC = new Agent({
    name: 'On Topic Agent',
    instructions: AGENT_PROMPT,
    model: 'gpt-5',
    modelSettings: {
        temperature: 1,
        topP: 1,
        maxTokens: 800,
        store: false,
        reasoning: {
            effort: 'low',
        },
    },
});
