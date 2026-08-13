#!/usr/bin/env bun
/**
 * Production start script — backend ONLY (no dashboard)
 */

import { exit } from "node:process";

const port = process.env.PORT ?? "1930";

console.log(`╔══════════════════════════════════════╗`);
console.log(`║   Pool Proxy — Backend Only Mode     ║`);
console.log(`╠══════════════════════════════════════╣`);
console.log(`║  Backend:   http://localhost:${port}    ║`);
console.log(`╚══════════════════════════════════════╝\n`);

// Start backend only (skip dashboard entirely)
const backend = Bun.spawn([
    "bun",
    "src/index.ts",
], {
    cwd: "/app",
    stdout: "inherit",
    stderr: "inherit",
    env: {
        ...process.env,
        PORT: port,
        NODE_ENV: "production",
    },
});

backend.exited.then(async (code) => {
    console.error(`[production] Backend exited with code ${code}`);
    exit(code || 1);
});

// Wait forever
await new Promise(() => {});
