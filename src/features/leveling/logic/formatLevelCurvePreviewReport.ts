import { EXTRA_LONG_MESSAGE_SAMPLE_LENGTH, LONG_MESSAGE_SAMPLE_LENGTH, SHORT_MESSAGE_SAMPLE_LENGTH } from '../constants';
import { ActionCountEstimate, LevelCurvePreview, XpRange } from './levelCurvePreview';

export function formatLevelCurvePreviewReport(preview: LevelCurvePreview): string {
    const lines: string[] = [
        `Leveling curve preview (through level ${preview.maxLevel})`,
        'MEE6-style curve · Estimates ignore cooldowns · Message XP uses log-interpolated keyframes',
        '',
        'XP per action:',
        `  Short msg (~${SHORT_MESSAGE_SAMPLE_LENGTH} chars):       ${preview.shortMessageXp} XP`,
        `  Long msg (~${LONG_MESSAGE_SAMPLE_LENGTH} chars):      ${preview.longMessageXp} XP`,
        `  Extra long (~${EXTRA_LONG_MESSAGE_SAMPLE_LENGTH} chars): ${preview.extraLongMessageXp} XP`,
        `  Reactions:             ${preview.reactionXp ? formatXpRange(preview.reactionXp) : 'disabled'}`,
        `  Photo msgs:            ${
            preview.photoMessageXp ? `${formatXpRange(preview.photoMessageXp)} (length-scaled msg + bonus)` : 'disabled'
        }`,
        '',
        'Per level step (actions for that step only):',
        '',
        formatTableHeader(),
        ...preview.steps.map((step) =>
            formatTableRow(
                step.nextLevel,
                step.xpRequired,
                step.shortMessages,
                step.longMessages,
                step.extraLongMessages,
                step.reactions,
                step.photoMessages
            )
        ),
        '',
        formatCumulativeSummary(preview),
    ];

    return lines.join('\n');
}

function formatTableHeader(): string {
    return [
        padRight('Lvl→', 5),
        padRight('XP', 6),
        padRight('Short', 8),
        padRight('Long', 8),
        padRight('XLong', 8),
        padRight('React', 14),
        padRight('Photo', 14),
    ].join('');
}

function formatTableRow(
    nextLevel: number,
    xpRequired: number,
    shortMessages: ActionCountEstimate,
    longMessages: ActionCountEstimate,
    extraLongMessages: ActionCountEstimate,
    reactions: ActionCountEstimate | null,
    photoMessages: ActionCountEstimate | null
): string {
    return [
        padRight(String(nextLevel), 5),
        padRight(String(xpRequired), 6),
        padRight(formatEstimate(shortMessages), 8),
        padRight(formatEstimate(longMessages), 8),
        padRight(formatEstimate(extraLongMessages), 8),
        padRight(formatEstimate(reactions), 14),
        padRight(formatEstimate(photoMessages), 14),
    ].join('');
}

function formatCumulativeSummary(preview: LevelCurvePreview): string {
    const cumulative = preview.cumulativeToMaxLevel;

    return [
        `Total from level 1 → ${preview.maxLevel}: ${cumulative.totalXp.toLocaleString()} XP`,
        `  Short messages:       ${formatEstimateInline(cumulative.shortMessages)}`,
        `  Long messages:        ${formatEstimateInline(cumulative.longMessages)}`,
        `  Extra long messages:  ${formatEstimateInline(cumulative.extraLongMessages)}`,
        `  Reactions only:       ${cumulative.reactions ? formatEstimateInline(cumulative.reactions) : 'n/a'}`,
        `  Photo msgs only:      ${cumulative.photoMessages ? formatEstimateInline(cumulative.photoMessages) : 'n/a'}`,
    ].join('\n');
}

function formatXpRange(range: XpRange): string {
    return `${range.min}–${range.max} XP (~${Math.round(range.avg)} avg)`;
}

function formatEstimate(estimate: ActionCountEstimate | null): string {
    if (!estimate) {
        return 'n/a';
    }

    if (estimate.min === estimate.max) {
        return String(estimate.avg);
    }

    return `${estimate.min}–${estimate.max}, ~${estimate.avg}`;
}

function formatEstimateInline(estimate: ActionCountEstimate): string {
    if (estimate.min === estimate.max) {
        return `${estimate.avg} actions`;
    }

    return `${estimate.min}–${estimate.max} actions (~${estimate.avg} avg)`;
}

function padRight(value: string, width: number): string {
    return value.padEnd(width, ' ');
}
