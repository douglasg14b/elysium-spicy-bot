/**
 * The two views of leveling, as a link row.
 *
 * Shared by both pages rather than written twice: the tabs have to agree about which one is
 * active, and a second copy is how a tab ends up highlighted on the page it does not point at.
 *
 * Each tab renders an anchor rather than calling `navigate` from `onChange`: these are real
 * routes an operator can bookmark, middle-click and land on directly, and driving them through
 * a state handler would make the highlight a second source of truth beside the URL. `value` is
 * read from the location, so the URL is the only thing that decides.
 *
 * `renderRoot` rather than `component={Link}` because `Tabs.Tab` does not forward polymorphic
 * props in this Mantine version — its props are typed against `HTMLButtonElement`, so `to`
 * is rejected. `renderRoot` is Mantine's own escape hatch for exactly this and keeps the
 * anchor real rather than a div with a click handler.
 *
 * Not in `pages/` because it is not a page, and not in `layout/` because it belongs to one
 * feature — it sits beside the other leveling modules the two pages already share.
 */

import { Tabs } from '@mantine/core';
import { IconChartHistogram, IconListNumbers } from '@tabler/icons-react';
import { Link, useMatch } from 'react-router-dom';

/** Which tab is showing. Local: the component derives it, nobody passes it in. */
type LevelingTab = 'leaderboard' | 'insights';

const TAB_PATHS: Readonly<Record<LevelingTab, string>> = {
    leaderboard: '/leveling',
    insights: '/leveling/insights',
};

export function LevelingTabs() {
    /*
     * `useMatch` rather than comparing `useLocation().pathname` to the string: the router
     * normalises a trailing slash, and an equality test does not — `/leveling/insights/` renders
     * the insights page while highlighting Leaderboard, which is the exact desync this component
     * exists to prevent.
     *
     * Matched on the insights path specifically rather than a prefix of `/leveling`:
     * `/leveling/:userId` is a *sibling* of it, so a prefix test would light Insights up on every
     * member's page. Anything else under `/leveling` — a member included — belongs to the
     * leaderboard, which is where its breadcrumb points.
     */
    const onInsights = useMatch(TAB_PATHS.insights);
    const active: LevelingTab = onInsights ? 'insights' : 'leaderboard';

    return (
        <Tabs value={active} variant="default" color="brand">
            <Tabs.List>
                <Tabs.Tab
                    value="leaderboard"
                    leftSection={<IconListNumbers size={15} />}
                    renderRoot={(props) => <Link to={TAB_PATHS.leaderboard} {...props} />}
                >
                    Leaderboard
                </Tabs.Tab>
                <Tabs.Tab
                    value="insights"
                    leftSection={<IconChartHistogram size={15} />}
                    renderRoot={(props) => <Link to={TAB_PATHS.insights} {...props} />}
                >
                    Insights
                </Tabs.Tab>
            </Tabs.List>
        </Tabs>
    );
}
