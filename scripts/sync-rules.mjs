import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');

const SYNC_DIRS = [
    { src: '.cursor/rules', dest: '.claude/rules', transform: stripGlobsLine },
    { src: '.cursor/agents', dest: '.claude/agents', transform: stripModelLine },
    { src: '.cursor/skills', dest: '.claude/skills', transform: null },
];

const CURSOR_PREFIXES = SYNC_DIRS.map((d) => `${d.src}/`);

async function readStdinJson() {
    return new Promise((resolve) => {
        const chunks = [];
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.on('line', (line) => chunks.push(line));
        rl.on('close', () => {
            try {
                resolve(JSON.parse(chunks.join('\n')));
            } catch {
                resolve(null);
            }
        });
        // Resolve immediately if stdin has no data (e.g. manual invocation)
        setTimeout(() => resolve(null), 100);
    });
}

// Sources are a mix of LF and CRLF, so match an optional \r before the newline.
function stripGlobsLine(content) {
    return content.replace(/^globs:.*\r?\n/gm, '');
}

// Cursor pins a Cursor-only model; drop the key so Claude Code applies its
// configured default rather than a value that goes stale.
function stripModelLine(content) {
    return content.replace(/^model:.*\r?\n/gm, '');
}

async function copyDir(srcAbs, destAbs, transform) {
    await fs.mkdir(destAbs, { recursive: true });
    const entries = await fs.readdir(srcAbs, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(srcAbs, entry.name);
        const destName = entry.name.replace(/\.mdc$/, '.md');
        const destPath = path.join(destAbs, destName);

        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath, transform);
        } else {
            const content = await fs.readFile(srcPath, 'utf8');
            await fs.writeFile(destPath, transform ? transform(content) : content, 'utf8');
            const rel = path.relative(ROOT, destPath).replace(/\\/g, '/');
            console.log(`synced: ${path.relative(ROOT, srcPath).replace(/\\/g, '/')} → ${rel}`);
        }
    }
}

async function syncAll() {
    for (const { src, dest, transform } of SYNC_DIRS) {
        await copyDir(path.join(ROOT, src), path.join(ROOT, dest), transform);
    }
}

const fromCursorHook = process.argv.includes('--from-cursor-hook');

if (fromCursorHook) {
    const payload = await readStdinJson();
    const filePath = payload?.file_path ?? '';
    const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');
    if (!CURSOR_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
        process.exit(0);
    }
}

await syncAll();
