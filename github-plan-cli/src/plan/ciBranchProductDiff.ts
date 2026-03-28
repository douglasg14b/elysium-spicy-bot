import type { SimpleGit } from 'simple-git';
import { z } from 'zod';

/** Paths under these prefixes count as “product” diff vs default (excludes `.jarvis/**`). */
const PRODUCT_PATH_PREFIXES = ['src/', 'migrations/'] as const;

const minFilesSchema = z.coerce.number().int().min(0).max(10_000);
const minLinesSchema = z.coerce.number().int().min(0).max(10_000_000);

/** Default thresholds for skipping the first CI implementer pass. */
export const CI_SKIP_IMPLEMENT_MIN_FILES_DEFAULT = 3;
export const CI_SKIP_IMPLEMENT_MIN_LINES_DEFAULT = 80;

export function resolveCiSkipImplementMinFiles(): number {
    const raw = process.env.CI_SKIP_IMPLEMENT_MIN_FILES;
    if (raw === undefined || raw.trim() === '') {
        return CI_SKIP_IMPLEMENT_MIN_FILES_DEFAULT;
    }
    const parsed = minFilesSchema.safeParse(raw);
    return parsed.success ? parsed.data : CI_SKIP_IMPLEMENT_MIN_FILES_DEFAULT;
}

export function resolveCiSkipImplementMinLines(): number {
    const raw = process.env.CI_SKIP_IMPLEMENT_MIN_LINES;
    if (raw === undefined || raw.trim() === '') {
        return CI_SKIP_IMPLEMENT_MIN_LINES_DEFAULT;
    }
    const parsed = minLinesSchema.safeParse(raw);
    return parsed.success ? parsed.data : CI_SKIP_IMPLEMENT_MIN_LINES_DEFAULT;
}

export function isCiProductDiffPath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').trim();
    if (normalized === '' || normalized.startsWith('.jarvis/')) {
        return false;
    }
    for (const prefix of PRODUCT_PATH_PREFIXES) {
        if (prefix.endsWith('/')) {
            if (normalized.startsWith(prefix)) {
                return true;
            }
        } else if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
            return true;
        }
    }
    return false;
}

export type CiProductDiffMetrics = {
    readonly productFileCount: number;
    readonly productLineChurn: number;
    readonly productPaths: readonly string[];
};

const MAX_PATHS_RETURNED = 500;

/**
 * Parses `git diff --numstat` lines: `added\tdeleted\tpath` (path may contain tabs rarely; numstat uses tab).
 */
export function parseGitNumstatForProductMetrics(numstatStdout: string): CiProductDiffMetrics {
    const lines = numstatStdout.split(/\r?\n/);
    const paths: string[] = [];
    let lineChurn = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }
        const tabParts = trimmed.split('\t');
        if (tabParts.length < 3) {
            continue;
        }
        const addedRaw = tabParts[0] ?? '';
        const deletedRaw = tabParts[1] ?? '';
        const pathPart = tabParts.slice(2).join('\t');
        if (!isCiProductDiffPath(pathPart)) {
            continue;
        }
        const added = addedRaw === '-' ? 0 : Number(addedRaw);
        const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw);
        if (!Number.isFinite(added) || !Number.isFinite(deleted)) {
            continue;
        }
        lineChurn += added + deleted;
        paths.push(pathPart);
    }

    const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
    const capped = unique.slice(0, MAX_PATHS_RETURNED);

    return {
        productFileCount: unique.length,
        productLineChurn: lineChurn,
        productPaths: capped,
    };
}

export function shouldSkipFirstCiImplementPass(metrics: CiProductDiffMetrics): boolean {
    const minFiles = resolveCiSkipImplementMinFiles();
    const minLines = resolveCiSkipImplementMinLines();
    return metrics.productFileCount >= minFiles || metrics.productLineChurn >= minLines;
}

/**
 * `git diff --numstat origin/${defaultBranch}...HEAD` scoped to product paths.
 */
export async function getCiBranchProductDiffMetrics(
    git: SimpleGit,
    defaultBranch: string,
): Promise<CiProductDiffMetrics> {
    const range = `origin/${defaultBranch}...HEAD`;
    const stdout = await git.raw(['diff', '--numstat', range]);
    return parseGitNumstatForProductMetrics(stdout);
}
