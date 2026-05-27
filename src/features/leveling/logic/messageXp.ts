import {
    EXTRA_LONG_MESSAGE_SAMPLE_LENGTH,
    LONG_MESSAGE_SAMPLE_LENGTH,
    MESSAGE_XP_CAP,
    MESSAGE_XP_KEYFRAMES,
    SHORT_MESSAGE_SAMPLE_LENGTH,
} from '../constants';

/**
 * Log-space interpolation between {@link MESSAGE_XP_KEYFRAMES} so marginal XP per character drops
 * as messages get longer, while hitting each anchor exactly.
 */
export function interpolateMessageXpFromKeyframes(length: number): number {
    if (length <= 0) {
        return MESSAGE_XP_KEYFRAMES[0].xp;
    }

    if (length <= MESSAGE_XP_KEYFRAMES[0].length) {
        return MESSAGE_XP_KEYFRAMES[0].xp;
    }

    for (let index = 0; index < MESSAGE_XP_KEYFRAMES.length - 1; index++) {
        const left = MESSAGE_XP_KEYFRAMES[index];
        const right = MESSAGE_XP_KEYFRAMES[index + 1];

        if (length <= right.length) {
            const leftLog = Math.log1p(left.length);
            const rightLog = Math.log1p(right.length);
            const lengthLog = Math.log1p(length);
            const progress = (lengthLog - leftLog) / (rightLog - leftLog);

            return left.xp + progress * (right.xp - left.xp);
        }
    }

    return MESSAGE_XP_CAP;
}

export function calculateMessageXp(
    content: string,
    xpMin: number,
    xpMax: number,
    randomValue: number = 0.5
): number {
    const length = content.trim().length;

    if (length === 0) {
        return xpMin;
    }

    if (xpMin > xpMax) {
        throw new Error(`Invalid XP range: min (${xpMin}) must be <= max (${xpMax})`);
    }

    const scaledXp = interpolateMessageXpFromKeyframes(length);
    const jitter = (randomValue - 0.5) * 2;

    return Math.min(MESSAGE_XP_CAP, Math.max(1, Math.round(scaledXp + jitter)));
}

export function sampleMessageContent(length: number): string {
    if (length <= 0) {
        return '';
    }

    return 'x'.repeat(length);
}

export function getRepresentativeMessageXp(input: {
    xpMin: number;
    xpMax: number;
    sampleLength: number;
}): number {
    return calculateMessageXp(sampleMessageContent(input.sampleLength), input.xpMin, input.xpMax, 0.5);
}

export function getShortMessageXp(xpMin: number, xpMax: number): number {
    return getRepresentativeMessageXp({
        xpMin,
        xpMax,
        sampleLength: SHORT_MESSAGE_SAMPLE_LENGTH,
    });
}

export function getLongMessageXp(xpMin: number, xpMax: number): number {
    return getRepresentativeMessageXp({
        xpMin,
        xpMax,
        sampleLength: LONG_MESSAGE_SAMPLE_LENGTH,
    });
}

export function getExtraLongMessageXp(xpMin: number, xpMax: number): number {
    return getRepresentativeMessageXp({
        xpMin,
        xpMax,
        sampleLength: EXTRA_LONG_MESSAGE_SAMPLE_LENGTH,
    });
}

export function getMessageXpCap(): number {
    return MESSAGE_XP_CAP;
}
