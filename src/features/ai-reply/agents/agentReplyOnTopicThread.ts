import { Agent } from '@openai/agents';
import { buildAgentPromptInstructions } from './agentBase';

const INSTRUCTIONS_PROMPT = `The user has replied to something you said or they replied to another message and mentioned you. Reply in turn. Your reply should be no more than two or three sentences.`;

const AGENT_PROMPT = buildAgentPromptInstructions(INSTRUCTIONS_PROMPT);

export const AGENT_REPLY_ON_TOPIC_THREAD = new Agent({
    name: 'On Topic Thread Agent',
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
