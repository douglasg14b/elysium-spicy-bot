import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { PREVIEW_PAGES_PATH, type PreviewPage } from './previewPages';

/**
 * Screenshot every page the running preview seeded, at several widths:
 *
 *   pnpm preview:shoot [--base http://localhost:5190] [--only flows-list,settings]
 *                      [--widths 1440,1280,1024,390] [--out web/e2e/preview/.shots]
 *
 * Start `pnpm preview:dashboard` first. Each page is written as `<name>@<width>.png`,
 * full height. Alongside each file this prints what a picture can hide: horizontal
 * overflow, containers that scroll sideways, text cut off inside its box, console
 * errors, and failed API calls.
 *
 * Uses the installed Chrome rather than a downloaded browser, so nothing is fetched to run it.
 */

const { values } = parseArgs({
    options: {
        base: { type: 'string', default: 'http://localhost:5190' },
        only: { type: 'string' },
        widths: { type: 'string', default: '1440,1280,1024,390' },
        out: { type: 'string', default: 'web/e2e/preview/.shots' },
    },
});

const HEIGHT = 900;

interface PageFindings {
    readonly overflowX: number;
    readonly clipped: readonly string[];
    readonly scrollers: readonly string[];
}

/**
 * Two things a full-page picture hides:
 *
 *  - **Clipped text**: elements whose text is wider than their box and hidden rather than
 *    wrapped. An ellipsis is a choice, so those are reported too: whether it is the right
 *    choice is the reviewer's call, and the list says where to look.
 *  - **Sideways scrollers**: containers whose content runs past their right edge. The
 *    screenshot shows only the part in view, so a table whose last column needs a scroll
 *    looks like a table that ends there.
 */
async function inspect(page: Page): Promise<PageFindings> {
    return page.evaluate(() => {
        const clipped: string[] = [];
        const scrollers: string[] = [];
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
            if (element.closest('[aria-hidden="true"]')) continue;
            const style = getComputedStyle(element);
            const hidden = element.scrollWidth - element.clientWidth;
            if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && hidden > 1) {
                const label = element.innerText.trim().split('\n')[0]?.slice(0, 60) ?? '';
                scrollers.push(`${hidden}px out of view in the box starting "${label}"`);
            }
            if (element.children.length > 0 || !element.textContent?.trim()) continue;
            const hides = style.overflow === 'hidden' || style.overflowX === 'hidden' || style.textOverflow === 'ellipsis';
            if (hides && hidden > 1) {
                clipped.push(`"${element.textContent.trim().slice(0, 80)}" (${element.clientWidth}px box, ${element.scrollWidth}px text)`);
            }
        }
        return {
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
            clipped,
            scrollers,
        };
    });
}

async function main(): Promise<void> {
    const base = values.base;
    const out = resolve(values.out);
    const widths = values.widths.split(',').map(Number);
    await mkdir(out, { recursive: true });

    const listing = await fetch(`${base}${PREVIEW_PAGES_PATH}`).catch(() => null);
    if (!listing?.ok) {
        throw new Error(`No preview answered at ${base}. Start one with \`pnpm preview:dashboard\`.`);
    }
    const { pages } = (await listing.json()) as { pages: PreviewPage[] };
    const only = values.only?.split(',');
    const chosen = only ? pages.filter((page) => only.includes(page.name)) : pages;
    if (only && chosen.length !== only.length) {
        throw new Error(`Unknown page(s). The preview seeded: ${pages.map((page) => page.name).join(', ')}`);
    }

    const browser = await chromium.launch({ channel: 'chrome' });
    try {
        for (const width of widths) {
            const context = await browser.newContext({ viewport: { width, height: HEIGHT }, colorScheme: 'dark' });
            for (const target of chosen) {
                const page = await context.newPage();
                const problems: string[] = [];
                page.on('console', (message) => {
                    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
                });
                page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
                page.on('response', (response) => {
                    if (response.url().includes('/api/') && response.status() >= 400) {
                        problems.push(`API ${response.status()}: ${response.request().method()} ${new URL(response.url()).pathname}`);
                    }
                });

                await page.goto(`${base}${target.path}`, { waitUntil: 'networkidle' });
                // Mantine's transitions are short; this lets the last one land before the picture.
                await page.waitForTimeout(300);

                const file = join(out, `${target.name}@${width}.png`);
                await page.screenshot({ path: file, fullPage: true });
                const findings = await inspect(page);

                console.log(`${file}`);
                if (findings.overflowX > 0) console.log(`  overflows horizontally by ${findings.overflowX}px`);
                for (const scroller of findings.scrollers) console.log(`  scrolls sideways: ${scroller}`);
                for (const clipped of findings.clipped) console.log(`  clipped: ${clipped}`);
                for (const problem of problems) console.log(`  ${problem}`);
                await page.close();
            }
            await context.close();
        }
    } finally {
        await browser.close();
    }
}

await main();
