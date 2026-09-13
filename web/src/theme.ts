import { createTheme, type MantineColorsTuple, rem } from '@mantine/core';

/**
 * SpicyBot brand theme — a *fully customized* Mantine theme, not stock Mantine.
 * Primary accent is cyan (#00A2FF) from the mascot logo (see the design doc), not
 * Discord blurple. Dark surfaces mirror the approved mockups.
 *
 * Brand ref: memory `spicybot-brand-and-web-stack`; docs `nimbalyst-local/plans`.
 */

// Cyan brand ramp centered on #00A2FF (index 6 is the default primary shade).
const brand: MantineColorsTuple = [
    '#e3f6ff',
    '#c8e9ff',
    '#95d2ff',
    '#5ebaff',
    '#33a7ff',
    '#199cff',
    '#00a2ff', // primary
    '#0088d6',
    '#006dae',
    '#005187',
];

// Neutral dark surfaces tuned to the mockup (bg-darkest → panels), replacing
// Mantine's default gray dark scale so the whole app reads as the SpicyBot slate.
const slate: MantineColorsTuple = [
    '#e8e9ed',
    '#c7c9d1',
    '#9aa0ac',
    '#6c7079',
    '#4a4d5c',
    '#383a47',
    '#313340',
    '#2a2b34',
    '#202128',
    '#1a1b23',
];

export const theme = createTheme({
    primaryColor: 'brand',
    primaryShade: { light: 6, dark: 6 },
    colors: {
        brand,
        dark: slate,
    },
    white: '#e8e9ed',
    black: '#1a1b23',
    defaultRadius: 'md',
    radius: {
        xs: rem(6),
        sm: rem(8),
        md: rem(10),
        lg: rem(14),
        xl: rem(20),
    },
    fontFamily:
        '"gg sans", "Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    headings: {
        fontFamily:
            '"gg sans", "Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
        fontWeight: '800',
    },
    other: {
        /**
         * Shared measure for dashboard pages, so every page caps at the same width
         * instead of each repeating its own magic number. Read via `useMantineTheme()`
         * or the `PAGE_MAX_WIDTH` re-export below.
         */
        pageMaxWidth: 1100,
    },
    components: {
        Button: {
            defaultProps: { radius: 'md', fw: 700 },
        },
        Card: {
            defaultProps: { radius: 'lg', withBorder: true },
        },
        Paper: {
            defaultProps: { radius: 'lg' },
        },
        Badge: {
            defaultProps: { radius: 'xl' },
        },
        Modal: {
            defaultProps: { radius: 'lg', centered: true },
        },
        Tooltip: {
            defaultProps: { radius: 'sm' },
        },
    },
});

/** Convenience re-export of `theme.other.pageMaxWidth` for page-level `maw`. */
export const PAGE_MAX_WIDTH = theme.other!.pageMaxWidth as number;
