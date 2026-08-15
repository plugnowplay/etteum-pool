import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { Drawer, DrawerSection, KeyValue } from "@/components/ui/drawer";
import { clearAuthLogs, fetchAuthLogs, fetchAuthQueue, fetchWarmupQueue, loginAccount, loginAccounts, stopAllAccounts } from "@/lib/api";
import { useWsEvent, useWsStatus } from "@/hooks/useWebSocket";
import { AlertTriangle, CheckCircle, ListChecks, Loader2, RefreshCw, RotateCcw, Trash2, Radio, StopCircle } from "lucide-react";
import { formatTimeID } from "@/lib/utils";

interface AuthLog {
  id: number;
  timestamp: string;
  type: string;
  accountId?: number;
  email?: string;
  provider?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
}

interface ProcessLog {
  key: string;
  operation: string;
  latest: AuthLog;
  events: AuthLog[];
  startedAt: string;
  updatedAt: string;
}

const liveTypes: string[] = [
  "queue_added", "queue_processing", "login_progress", "login_success", "login_failed", "queue_complete", "queue_cleared",
];
// Note: warmup_* events are explicitly filtered out - Login Logs only shows login operations

function statusVariant(type: string): "success" | "warning" | "error" | "secondary" {
  if (type.includes("success") || type === "queue_complete" || type === "warmup_complete") return "success";
  if (type.includes("failed") || type.includes("auth_error")) return "error";
  if (type.includes("processing") || type.includes("progress") || type.includes("exhausted") || type.includes("transient") || type.includes("unsupported")) return "warning";
  return "secondary";
}

function processStatusVariant(process: ProcessLog): "success" | "warning" | "error" | "secondary" {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusVariant(process.latest.type);
}

function processStatusLabel(process: ProcessLog) {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusLabel(process.latest.type);
}

function providerLabel(provider?: string) {
  if (!provider) return "-";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codebuddy-china") return "CodeBuddy CN";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function operationFor(type: string) {
  return type.startsWith("warmup_") ? "WarmUp" : "Login";
}

function processKey(log: AuthLog) {
  const account = log.accountId || log.email || log.id;
  return `${operationFor(log.type)}-${account}`;
}

function statusLabel(type: string) {
  return type.replace(/^login_/, "").replace(/^warmup_/, "").replace(/^queue_/, "").replace(/_/g, " ");
}

function mergeLogs(current: AuthLog[], incoming: AuthLog[]) {
  const map = new Map<string, AuthLog>();
  for (const log of [...current, ...incoming]) {
    const key = `${log.id}-${log.timestamp}-${log.type}-${log.accountId || ""}-${log.step || ""}`;
    map.set(key, log);
  }
  return [...map.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function logsToProcesses(logs: AuthLog[]): ProcessLog[] {
  const groups = new Map<string, ProcessLog>();
  const oldestFirst = [...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const log of oldestFirst) {
    const key = processKey(log);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        operation: operationFor(log.type),
        latest: log,
        events: [log],
        startedAt: log.timestamp,
        updatedAt: log.timestamp,
      });
      continue;
    }

    existing.events.push(log);
    existing.latest = { ...log, email: log.email || existing.latest.email, provider: log.provider || existing.latest.provider };
    existing.updatedAt = log.timestamp;
  }

  // Sort by queue order (startedAt) — position stays stable as new logs arrive
  return [...groups.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export default function BotLogs() {
  const [logs, setLogs] = useState<AuthLog[]>([]);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const queueRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsStatus = useWsStatus();
  const connected = wsStatus === "open";

  async function load() {
    const [logRes, queueRes] = await Promise.all([
      fetchAuthLogs(300) as Promise<{ data: AuthLog[] }>,
      fetchAuthQueue().catch(() => null),
    ]);
    // Filter out all warmup logs - Login Logs only shows login operations
    setLogs((current) => mergeLogs(current, (logRes.data || []).filter((log) => !log.type.startsWith("warmup_"))));
    setQueue(queueRes);
  }

  const refreshQueues = useCallback(async () => {
    const queueRes = await fetchAuthQueue().catch(() => null);
    setQueue(queueRes);
  }, []);

  const scheduleQueueRefresh = useCallback(() => {
    if (queueRefreshTimerRef.current) return;
    queueRefreshTimerRef.current = setTimeout(() => {
      queueRefreshTimerRef.current = null;
      refreshQueues();
    }, 300);
  }, [refreshQueues]);

  useEffect(() => {
    load().catch(() => {});
    return () => {
      if (queueRefreshTimerRef.current) {
        clearTimeout(queueRefreshTimerRef.current);
        queueRefreshTimerRef.current = null;
      }
    };
  }, []);

  useWsEvent(liveTypes, (msg) => {
    // Skip all warmup events - Login Logs only shows login operations
    if (msg.type.startsWith("warmup_")) return;

    if (msg.type === "queue_complete") {
      setQueue((current: any) => ({ ...(current || {}), ...(msg.data || {}), queued: 0, active: 0, processing: false }));
    }
    if (msg.type === "queue_cleared") {
      setQueue((current: any) => ({ ...(current || {}), queued: 0, active: 0, processing: false }));
    }
    const data = msg.data || {};
    const log: AuthLog = {
      id: data.logId || data.id || Date.now(),
      timestamp: data.timestamp || new Date().toISOString(),
      type: msg.type,
      accountId: data.accountId || data.id,
      email: data.email,
      provider: data.provider,
      step: data.step,
      message: data.message || data.error || msg.type,
      error: data.error,
      data,
    };
    setLogs((current) => mergeLogs(current, [log]));
    scheduleQueueRefresh();
  });

  const failed = useMemo(() => logs.filter((log) => log.type === "login_failed"), [logs]);
  const failedAccounts = useMemo(() => {
    const map = new Map<string, AuthLog>();
    for (const log of failed) {
      const key = `${log.accountId || log.email || log.id}-${log.provider || "unknown"}`;
      if (!map.has(key) || new Date(log.timestamp).getTime() > new Date(map.get(key)!.timestamp).getTime()) {
        map.set(key, log);
      }
    }
    return [...map.values()];
  }, [failed]);
  const processes = useMemo(() => {
    return logsToProcesses(logs).filter((process) => {
      // Exclude pending items that haven't started processing yet
      if (process.events.length === 1) {
        const type = process.events[0].type;
        if (type === "queue_added" || type === "warmup_queue_added") return false;
      }
      return true;
    });
  }, [logs]);
  const running = Number(queue?.active || 0);
  const queued = Number(queue?.queued || 0);
  const warmupRunning = Number(warmupQueue?.active || 0);
  const warmupQueued = Number(warmupQueue?.queued || 0);

  // Use backend queue stats for accurate counts (lightweight, no frontend recalculation)
  const totalProgress = running + warmupRunning;
  const totalSuccess = Number(queue?.totalSuccess || 0) + Number(warmupQueue?.totalSuccess || 0);
  const totalFailed = Number(queue?.totalFailed || 0) + Number(warmupQueue?.totalFailed || 0);
  const totalQueued = queued + warmupQueued;

  async function handleClear() {
    await clearAuthLogs();
    setLogs([]);
  }

  async function handleStopAll() {
    await stopAllAccounts();
    await load().catch(() => {});
  }

  async function handleRetry(accountId?: number) {
    if (!accountId) return;
    await loginAccount(accountId);
    await load().catch(() => {});
  }

  async function handleRetryAll() {
    const ids = Array.from(new Set(failedAccounts.map((log) => log.accountId).filter((id): id is number => Boolean(id))));
    if (ids.length === 0) return;
    await loginAccounts(ids);
    await load().catch(() => {});
  }

  const columns: Column<ProcessLog>[] = [
    {
      key: "time",
      header: "Time",
      width: "w-[92px]",
      sortValue: (p) => p.updatedAt,
      cell: (p) => (
        <span className="tabular font-mono text-xs text-[var(--muted-foreground)]">
          {formatTimeID(p.updatedAt)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[120px]",
      sortValue: (p) => processStatusLabel(p),
      cell: (p) => (
        <Badge variant={processStatusVariant(p)} dot>
          {processStatusLabel(p)}
        </Badge>
      ),
    },
    {
      key: "account",
      header: "Account",
      primary: true,
      hideBelow: "md",
      sortValue: (p) => p.latest.email ?? p.latest.accountId ?? "",
      cell: (p) => (
        <span className="block max-w-[220px] truncate text-sm text-[var(--foreground)]">
          {p.latest.email || (p.latest.accountId ? `#${p.latest.accountId}` : "-")}
        </span>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      hideBelow: "md",
      width: "w-[130px]",
      sortValue: (p) => p.latest.provider ?? "",
      cell: (p) => (
        <span className="text-sm text-[var(--muted-foreground)]">
          {providerLabel(p.latest.provider)}
        </span>
      ),
    },
    {
      key: "step",
      header: "Step",
      hideBelow: "lg",
      width: "w-[140px]",
      sortValue: (p) => p.latest.step ?? p.operation,
      cell: (p) => (
        <span className="block truncate text-xs text-[var(--muted-foreground)]">
          {p.latest.step || p.operation}
        </span>
      ),
    },
    {
      key: "message",
      header: "Message",
      sortValue: (p) => p.latest.error || p.latest.message || "",
      cell: (p) => {
        const label = processStatusLabel(p);
        const isRunning =
          label !== "success" &&
          label !== "error" &&
          (p.latest.type === "login_progress" ||
            p.latest.type === "queue_processing" ||
            p.latest.type === "warmup_processing");
        return (
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            {label === "success" && (
              <CheckCircle className="h-4 w-4 shrink-0 text-[var(--success)]" />
            )}
            {label === "error" && (
              <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--error)]" />
            )}
            {isRunning && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--warning)]" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {p.latest.error || p.latest.message || "-"}
            </span>
            <span className="tabular shrink-0 text-xs text-[var(--muted-foreground)]">
              {p.events.length} steps
            </span>
          </div>
        );
      },
    },
  ];

  const activeProcess = processes.find((p) => p.key === expanded) || null;

  return (
    <PageShell>
      <PageHeader
        title="Login Logs"
        description="Live progress for auto-login bot, including failed accounts."
        badge={
          <Badge variant={connected ? "success" : "muted"} dot>
            {connected ? "Live" : "Disconnected"}
          </Badge>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="destructive" size="sm" onClick={handleStopAll}>
              <StopCircle className="h-4 w-4" />
              Stop All
            </Button>
            <Button variant="outline" size="sm" onClick={handleClear}>
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Queue" value={totalQueued} icon={ListChecks} />
        <StatCard label="Progress" value={totalProgress} icon={Radio} tone="warning" />
        <StatCard label="Success" value={totalSuccess} icon={CheckCircle} tone="success" />
        <StatCard
          label="Failed"
          value={totalFailed}
          icon={AlertTriangle}
          tone={totalFailed > 0 ? "error" : "default"}
        />
      </div>

      {(totalProgress > 0 || totalQueued > 0) && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-sm text-[var(--warning)]">
          <Radio className="h-4 w-4 animate-pulse" />
          <span className="tabular">
            Sedang berjalan: {totalProgress} processing, {totalQueued} queued. Log akan update
            otomatis.
          </span>
        </div>
      )}

      {failedAccounts.length > 0 && (
        <Card className="border-[var(--error)]/30 bg-[var(--error)]/5">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-[var(--error)]" /> Failed Accounts
              </CardTitle>
              <Button variant="outline" size="sm" onClick={handleRetryAll}>
                <RotateCcw className="h-4 w-4" />
                <span className="tabular">Retry All ({failedAccounts.length})</span>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {failedAccounts.map((log) => (
              <div
                key={`failed-${log.accountId || log.id}-${log.provider || "unknown"}`}
                className="flex flex-col gap-2 rounded-md border border-[var(--error)]/20 bg-[var(--card)] px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--foreground)]">
                  {log.email || `Account #${log.accountId}`}
                </div>
                <div className="shrink-0 text-xs text-[var(--muted-foreground)] sm:w-[130px]">
                  {providerLabel(log.provider)}
                </div>
                <div
                  className="min-w-0 flex-1 truncate text-xs text-[var(--error)]"
                  title={log.error || log.message}
                >
                  {log.error || log.message}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => handleRetry(log.accountId)}
                  disabled={!log.accountId}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={processes}
        rowKey={(p) => p.key}
        activeKey={expanded}
        onRowClick={(p) => setExpanded((current) => (current === p.key ? null : p.key))}
        pageSize={25}
        empty={
          <EmptyState
            compact
            icon={ListChecks}
            title="No login logs yet"
            description="Add an account or start login to see progress here."
          />
        }
      />

      <Drawer
        open={Boolean(activeProcess)}
        onClose={() => setExpanded(null)}
        width="md"
        title={
          activeProcess
            ? activeProcess.latest.email ||
              (activeProcess.latest.accountId ? `#${activeProcess.latest.accountId}` : "Process")
            : ""
        }
        subtitle={activeProcess ? `${activeProcess.operation} · ${formatTimeID(activeProcess.updatedAt)}` : ""}
        meta={
          activeProcess ? (
            <>
              <Badge variant={processStatusVariant(activeProcess)} dot>
                {processStatusLabel(activeProcess)}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {providerLabel(activeProcess.latest.provider)}
              </Badge>
              <Badge variant="muted" className="tabular font-normal">
                {activeProcess.events.length} steps
              </Badge>
            </>
          ) : null
        }
      >
        {activeProcess && (
          <>
            <DrawerSection title="Summary">
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1">
                <KeyValue label="Operation" value={activeProcess.operation} />
                <KeyValue label="Started" mono value={formatTimeID(activeProcess.startedAt)} />
                <KeyValue label="Updated" mono value={formatTimeID(activeProcess.updatedAt)} />
                <KeyValue
                  label="Step"
                  value={activeProcess.latest.step || activeProcess.operation}
                />
              </div>
            </DrawerSection>

            <DrawerSection title="Timeline">
              <div className="space-y-2">
                {activeProcess.events.map((log) => (
                  <div
                    key={`${log.id}-${log.timestamp}`}
                    className="grid grid-cols-[72px_1fr] gap-3 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs sm:grid-cols-[72px_120px_1fr]"
                  >
                    <span className="tabular font-mono text-[var(--muted-foreground)]">
                      {formatTimeID(log.timestamp)}
                    </span>
                    <span className="hidden text-[var(--muted-foreground)] sm:block">
                      {log.step || statusLabel(log.type)}
                    </span>
                    <span
                      className={
                        log.error ? "text-[var(--error)]" : "text-[var(--foreground)]"
                      }
                    >
                      {log.error || log.message || "-"}
                    </span>
                  </div>
                ))}
              </div>
            </DrawerSection>
          </>
        )}
      </Drawer>
    </PageShell>
  );
}

