import { readFileSync, statSync } from 'node:fs';
import { HEARTBEAT_FILE, PID_FILE, READY_FILE } from './healthCheckConstants';

try {
    // 1) Bot reached "ready" at least once
    statSync(READY_FILE);

    // 2) Process exists
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (!Number.isInteger(pid)) process.exit(1);
    process.kill(pid, 0); // throws if pid is gone

    // 3) Heartbeat is fresh (<= 30s old)
    const ageMs = Date.now() - statSync(HEARTBEAT_FILE).mtimeMs;
    if (ageMs > 30_000) process.exit(1);

    process.exit(0);
} catch {
    process.exit(1);
}
