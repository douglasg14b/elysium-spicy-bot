import { Text } from '@mantine/core';
import { splitWordmark } from '../brand';
import { useBotIdentity } from './BotIdentityContext';

/**
 * The bot's name, with "Bot" accented in brand cyan. Renders the connected account's
 * name — so the dev application shows "BrattyBot Dev" — falling back to the bundled
 * name until Discord reports in.
 */
export function Wordmark({ size, fw }: { size: string; fw: number }) {
    const { name } = useBotIdentity();
    const { before, accent, after } = splitWordmark(name);

    return (
        <Text fw={fw} size={size}>
            {before}
            {accent && (
                <Text span c="brand">
                    {accent}
                </Text>
            )}
            {after}
        </Text>
    );
}
