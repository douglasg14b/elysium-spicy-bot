import { writeFileSync, unlinkSync } from 'node:fs';
import { HEARTBEAT_FILE, PID_FILE, READY_FILE } from './healthCheckConstants';

// THis exists to act as a heartbeat for the container orchestrator (e.g. Docker) to know the bot is alive & well.
// It creates three files in /tmp:
// 1) /tmp/bot.pid - contains the current process ID
// 2) /tmp/bot.heartbeat - updated every 2.5s with the current timestamp
// 3) /tmp/bot.ready - created once the bot has successfully logged in and is ready
// The healthcheck script checks for the existence of these files and ensures the heartbeat file is fresh.

writeFileSync(PID_FILE, String(process.pid));

export function flagBotReady() {
    try {
        writeFileSync(READY_FILE, 'ok');
    } catch {}
}

// Heartbeat every 2.5s
const heartBeat = setInterval(() => {
    try {
        writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    } catch {}
}, 2500);

function cleanup() {
    clearInterval(heartBeat);
    try {
        unlinkSync(PID_FILE);
    } catch {}
    try {
        unlinkSync(HEARTBEAT_FILE);
    } catch {}
    try {
        unlinkSync(READY_FILE);
    } catch {}
    process.exit(0);
}
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
