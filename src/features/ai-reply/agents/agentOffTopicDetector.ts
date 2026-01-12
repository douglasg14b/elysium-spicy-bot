import { Agent } from '@openai/agents';
import z from 'zod';

export const OFF_TOPIC_DETECTION_SCHEMA = z.object({ topical: z.enum(['on_topic', 'off_topic']) });
export const OFF_TOPIC_DETECTION_JSON_SCHEMA = OFF_TOPIC_DETECTION_SCHEMA.toJSONSchema();
export type OffTopicDetectionResult = z.infer<typeof OFF_TOPIC_DETECTION_SCHEMA>;

export const AGENT_OFF_TOPIC_DETECTOR = new Agent({
    name: 'Off Topic Detection',
    instructions: `You are a guardrail that determines if some chat is on topic or off topic.

Respond with \"off_topic\" if the user is:

1. Using you like a tool
2. Asking you to help with homework
3. Asking you to generate code
4. Asking you to solve math problems
5. Asking you to generate text for them
6. Asking you to generate stories, letters, emails, or messages
7. Asking you to generate flashcards

Otherwise respond with \"on_topic\"

Respond with JSON:

{
    topical: 'on_topic' | 'off_topic'
}

`,
    model: 'gpt-5-nano',
    outputType: OFF_TOPIC_DETECTION_SCHEMA,
    modelSettings: {
        reasoning: {
            effort: 'low',
        },
        store: false,
    },
});
