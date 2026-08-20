import { Hono } from "hono";

export const microwarpRouter = new Hono();

// Definisi 10 warp container — sinkron dengan docker-compose.yml + gost-warp-pool.yml
interface WarpDef {
  n: number;
  container: string;
  socksPort: number;
  httpPort: number;
  poolLabel: string; // label di proxy_pool DB (warp1..warp10)
}

const WARPS: WarpDef[] = [
  { n: 1, container: "microwarp", socksPort: 1080, httpPort: 2081, poolLabel: "warp1" },
  { n: 2, container: "microwarp-2", socksPort: 1082, httpPort: 2082, poolLabel: "warp2" },
  { n: 3, container: "microwarp-3", socksPort: 1083, httpPort: 2083, poolLabel: "warp3" },
  { n: 4, container: "microwarp-4", socksPort: 1084, httpPort: 2084, poolLabel: "warp4" },
  { n: 5, container: "microwarp-5", socksPort: 1085, httpPort: 2085, poolLabel: "warp5" },
  { n: 6, container: "microwarp-6", socksPort: 1086, httpPort: 2086, poolLabel: "warp6" },
  { n: 7, container: "microwarp-7", socksPort: 1087, httpPort: 2087, poolLabel: "warp7" },
  { n: 8, container: "microwarp-8", socksPort: 1088, httpPort: 2088, poolLabel: "warp8" },
  { n: 9, container: "microwarp-9", socksPort: 1089, httpPort: 2089, poolLabel: "warp9" },
  { n: 10, container: "microwarp-10", socksPort: 1090, httpPort: 2090, poolLabel: "warp10" },
];

interface WarpStatus {
  n: number;
  container: string;
  containerState: "running" | "restarting" | "stopped" | "unknown";
  containerUptime: string | null; // e.g. "42m", "3h"
  socksPort: number;
  httpPort: number;
  poolLabel: string;
  ip: string | null;
  ipLatencyMs: number | null;
  bridgeOk: boolean;
  error: string | null;
}

async function getContainerInfo(container: string): Promise<{ state: WarpStatus["containerState"]; uptime: string | null }> {
  try {
    const proc = Bun.spawn(
      ["docker", "inspect", "--format", "{{.State.Status}}|{{.State.StartedAt}}", container],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    if (exitCode !== 0 || !out) return { state: "unknown", uptime: null };
    const [status, startedAt] = out.split("|");
    let state: WarpStatus["containerState"] = "unknown";
    if (status === "running") state = "running";
    else if (status === "restarting") state = "restarting";
    else if (status === "exited" || status === "created" || status === "dead") state = "stopped";
    let uptime: string | null = null;
    if (startedAt && state === "running") {
      const startedMs = new Date(startedAt).getTime();
      if (!isNaN(startedMs)) {
        const secs = Math.floor((Date.now() - startedMs) / 1000);
        if (secs < 60) uptime = `${secs}s`;
        else if (secs < 3600) uptime = `${Math.floor(secs / 60)}m`;
        else if (secs < 86400) uptime = `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
        else uptime = `${Math.floor(secs / 86400)}d`;
      }
    }
    return { state, uptime };
  } catch {
    return { state: "unknown", uptime: null };
  }
}

async function probeIp(httpPort: number, timeoutMs = 8000): Promise<{ ip: string | null; latencyMs: number | null; error: string | null }> {
  const start = Date.now();
  try {
    const curlPath = Bun.which("curl") || "/usr/bin/curl";
    const proc = Bun.spawn(
      [curlPath, "-s", "--proxy", `http://127.0.0.1:${httpPort}`, "--max-time", String(Math.floor(timeoutMs / 1000)), "https://ifconfig.me"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    const latencyMs = Date.now() - start;
    if (exitCode !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      return { ip: null, latencyMs, error: err || `curl exit ${exitCode}` };
    }
    if (!out) return { ip: null, latencyMs, error: "empty response" };
    return { ip: out, latencyMs, error: null };
  } catch (err) {
    return { ip: null, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function collectStatus(w: WarpDef): Promise<WarpStatus> {
  const info = await getContainerInfo(w.container);
  // Kalau container gak running, jangan probe IP (buang-buang waktu)
  if (info.state !== "running") {
    return {
      n: w.n,
      container: w.container,
      containerState: info.state,
      containerUptime: info.uptime,
      socksPort: w.socksPort,
      httpPort: w.httpPort,
      poolLabel: w.poolLabel,
      ip: null,
      ipLatencyMs: null,
      bridgeOk: false,
      error: `container ${info.state}`,
    };
  }
  const probe = await probeIp(w.httpPort);
  return {
    n: w.n,
    container: w.container,
    containerState: info.state,
    containerUptime: info.uptime,
    socksPort: w.socksPort,
    httpPort: w.httpPort,
    poolLabel: w.poolLabel,
    ip: probe.ip,
    ipLatencyMs: probe.latencyMs,
    bridgeOk: probe.ip !== null,
    error: probe.error,
  };
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/microwarp/status — semua warp + IP live
// ─────────────────────────────────────────────────────────────────────
microwarpRouter.get("/status", async (c) => {
  const statuses = await Promise.all(WARPS.map((w) => collectStatus(w)));

  // Info timer auto-rotate (10 timer per-warp, staggered)
  const rotateInfo: { warp: number; next: string | null; last: string | null }[] = [];
  let anyEnabled = false;
  for (let n = 1; n <= 10; n++) {
    try {
      const proc = Bun.spawn(
        ["systemctl", "list-timers", `warp-rotate-${n}.timer`, "--no-pager", "--output=json"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = (await new Response(proc.stdout).text()).trim();
      const exitCode = await proc.exited;
      if (exitCode === 0 && out) {
        const parsed = JSON.parse(out);
        if (Array.isArray(parsed) && parsed.length > 0) {
          rotateInfo.push({ warp: n, next: parsed[0].next || null, last: parsed[0].last || null });
          if (parsed[0].next) anyEnabled = true;
          continue;
        }
      }
    } catch {}
    rotateInfo.push({ warp: n, next: null, last: null });
  }

  // Cari next/last global (yang paling dekat)
  const nexts = rotateInfo.map((r) => r.next).filter((v): v is string => !!v);
  const lasts = rotateInfo.map((r) => r.last).filter((v): v is string => !!v);
  const nextRotate = nexts.length > 0 ? nexts.reduce((a, b) => (Number(a) < Number(b) ? a : b)) : null;
  const lastRotate = lasts.length > 0 ? lasts.reduce((a, b) => (Number(a) > Number(b) ? a : b)) : null;

  // Attach next/last per warp ke status
  const warpsWithRotate = statuses.map((s) => {
    const info = rotateInfo.find((r) => r.warp === s.n);
    return { ...s, nextRotate: info?.next || null, lastRotate: info?.last || null };
  });

  return c.json({
    count: statuses.length,
    runningCount: statuses.filter((s) => s.containerState === "running").length,
    healthyCount: statuses.filter((s) => s.bridgeOk).length,
    autoRotate: {
      enabled: anyEnabled,
      intervalMinutes: 10,
      strategy: "per-container 10 min (staggered)",
      nextAt: nextRotate,
      lastAt: lastRotate,
    },
    warps: warpsWithRotate,
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/microwarp/rotate/:n — restart 1 warp (n=1..10)
// ─────────────────────────────────────────────────────────────────────
microwarpRouter.post("/rotate/:n", async (c) => {
  const n = Number(c.req.param("n"));
  const w = WARPS.find((w) => w.n === n);
  if (!w) return c.json({ error: "invalid warp number (expected 1..10)" }, 400);

  const before = await probeIp(w.httpPort);

  // Non-blocking restart
  const proc = Bun.spawn(["docker", "restart", w.container], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    return c.json({ error: `docker restart failed: ${err}` }, 500);
  }

  // Tunggu bridge ready (max 60s)
  let after: { ip: string | null; latencyMs: number | null; error: string | null } = { ip: null, latencyMs: null, error: null };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    after = await probeIp(w.httpPort, 5000);
    if (after.ip) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  return c.json({
    warp: w.n,
    container: w.container,
    oldIp: before.ip,
    newIp: after.ip,
    changed: !!(before.ip && after.ip && before.ip !== after.ip),
    bridgeOk: after.ip !== null,
    error: after.error,
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/microwarp/rotate-all — rotate berurutan (rolling)
// ─────────────────────────────────────────────────────────────────────
microwarpRouter.post("/rotate-all", async (c) => {
  const results: Array<{ warp: number; oldIp: string | null; newIp: string | null; changed: boolean; ok: boolean }> = [];
  for (const w of WARPS) {
    const before = await probeIp(w.httpPort);
    const proc = Bun.spawn(["docker", "restart", w.container], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      results.push({ warp: w.n, oldIp: before.ip, newIp: null, changed: false, ok: false });
      continue;
    }
    let after: { ip: string | null; latencyMs: number | null; error: string | null } = { ip: null, latencyMs: null, error: null };
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      after = await probeIp(w.httpPort, 5000);
      if (after.ip) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    results.push({
      warp: w.n,
      oldIp: before.ip,
      newIp: after.ip,
      changed: !!(before.ip && after.ip && before.ip !== after.ip),
      ok: !!after.ip,
    });
    // Jeda antar warp biar gak semua sekaligus down
    await new Promise((r) => setTimeout(r, 5000));
  }
  return c.json({ results });
});
