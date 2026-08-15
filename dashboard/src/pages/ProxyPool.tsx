import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { SkeletonCard } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  Globe,
  Plus,
  Trash2,
  Upload,
  RefreshCw,
  Power,
  PowerOff,
  Download,
  Activity,
  ShieldAlert,
  Timer,
} from "lucide-react";
import { fetchApi, fetchProxyCountries, scrapeProxies, type ProxyCountry } from "@/lib/api";

interface ProxyEntry {
  id: number;
  url: string;
  type: string;
  label: string | null;
  status: string;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  successCount: number;
  failCount: number;
  createdAt: string;
}

interface ProxyPoolStatus {
  count: number;
  activeCount: number;
  proxies: ProxyEntry[];
}

export default function ProxyPool() {
  const [pool, setPool] = useState<ProxyPoolStatus>({ count: 0, activeCount: 0, proxies: [] });
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState("");
  const [checking, setChecking] = useState(false);
  const toast = useToast();

  // Scrape controls
  const [countries, setCountries] = useState<ProxyCountry[]>([]);
  const [scrapeSource, setScrapeSource] = useState<"all" | "proxyscrape" | "geonode" | "proxifly">("all");
  const [scrapeCountry, setScrapeCountry] = useState("all");
  const [scrapeProtocol, setScrapeProtocol] = useState<"all" | "http" | "socks5">("all");
  const [scrapeLimit, setScrapeLimit] = useState(50);
  const [scrapeVerify, setScrapeVerify] = useState(true);
  const [scraping, setScraping] = useState(false);

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<ProxyPoolStatus>("/api/proxy-pool/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, activeCount: 0, proxies: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPool();
    fetchProxyCountries()
      .then((data) => setCountries(data.countries))
      .catch(() => setCountries([{ code: "all", name: "Any region" }]));
  }, [loadPool]);

  const handleScrape = async () => {
    setScraping(true);
    try {
      const result = await scrapeProxies({
        source: scrapeSource,
        country: scrapeCountry,
        protocol: scrapeProtocol,
        limit: scrapeLimit,
        verify: scrapeVerify,
      });
      if (result.added > 0) {
        toast.success(
          `Scraped ${result.scraped}, ${result.added} added` +
            (scrapeVerify ? ` (${result.verified} alive)` : "") +
            (result.skipped > 0 ? `, ${result.skipped} duplicates skipped` : ""),
        );
      } else if (result.scraped === 0) {
        toast.warning("No proxies found for that region/source");
      } else {
        toast.warning(
          scrapeVerify && result.verified === 0
            ? `Scraped ${result.scraped} but none passed health check`
            : "All scraped proxies already in pool",
        );
      }
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Scrape failed");
    } finally {
      setScraping(false);
    }
  };

  const handleBulkAdd = async () => {
    if (!bulkText.trim()) {
      toast.warning("Paste proxy list first");
      return;
    }

    const proxies = bulkText
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (proxies.length === 0) {
      toast.warning("No valid proxies found");
      return;
    }

    try {
      const result = await fetchApi<{ added: number }>("/api/proxy-pool/pool", {
        method: "POST",
        body: JSON.stringify({ proxies }),
      });
      setBulkText("");
      toast.success(`${result.added} proxy added`);
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Failed to add proxies");
    }
  };

  const handleToggle = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Failed to toggle proxy");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
      toast.success("Proxy removed");
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Failed to remove proxy");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all proxies from pool?")) return;
    try {
      await fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
      toast.success("Pool cleared");
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Failed to clear pool");
    }
  };

  const handleCheckSingle = async (id: number) => {
    try {
      const result = await fetchApi<{ ok: boolean; latencyMs: number; error?: string }>(
        `/api/proxy-pool/pool/${id}/check`,
        { method: "POST" }
      );
      if (result.ok) toast.success(`Healthy (${result.latencyMs}ms)`);
      else toast.error(`Failed: ${result.error}`);
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Health check failed");
    }
  };

  const handleCheckAll = async () => {
    setChecking(true);
    try {
      const result = await fetchApi<{ checked: number }>("/api/proxy-pool/pool/check-all", {
        method: "POST",
      });
      toast.success(`Checked ${result.checked} proxies`);
      loadPool();
    } catch (e: any) {
      toast.error(e.message || "Check all failed");
    } finally {
      setChecking(false);
    }
  };

  const statusTone = (status: string): "success" | "warning" | "error" | "muted" => {
    if (status === "active") return "success";
    if (status === "disabled") return "warning";
    if (status === "error") return "error";
    return "muted";
  };

  const latencyClass = (ms: number) =>
    ms < 1000
      ? "text-[var(--success)]"
      : ms < 3000
        ? "text-[var(--warning)]"
        : "text-[var(--error)]";

  const formatLatency = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  const maskUrl = (url: string) => {
    try {
      const u = new URL(url);
      const masked = u.password ? `${u.protocol}//${u.username}:***@${u.host}` : `${u.protocol}//${u.host}`;
      return masked;
    } catch {
      return url;
    }
  };

  const stats = useMemo(() => {
    const errored = pool.proxies.filter((p) => p.status === "error").length;
    const latencies = pool.proxies
      .map((p) => p.latencyMs || 0)
      .filter((ms) => ms > 0);
    const avgMs = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    return { errored, avgMs };
  }, [pool]);

  const columns: Column<ProxyEntry>[] = [
    {
      key: "url",
      header: "Proxy",
      primary: true,
      sortValue: (p) => p.url,
      cell: (p) => (
        <div className="flex min-w-0 items-center gap-2">
          <Globe className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
          <span className="truncate font-mono text-sm text-[var(--foreground)]">
            {maskUrl(p.url)}
          </span>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      width: "w-[90px]",
      hideBelow: "md",
      sortValue: (p) => p.type,
      cell: (p) => (
        <span className="text-xs text-[var(--muted-foreground)]">{p.type}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      sortValue: (p) => p.status,
      cell: (p) => (
        <Badge variant={statusTone(p.status)} dot>
          {p.status}
        </Badge>
      ),
    },
    {
      key: "latency",
      header: "Latency",
      align: "right",
      width: "w-[90px]",
      hideBelow: "md",
      sortValue: (p) => p.latencyMs ?? 0,
      cell: (p) =>
        p.latencyMs == null ? (
          <span className="text-xs text-[var(--muted-foreground)]">—</span>
        ) : (
          <span className={`tabular font-mono text-xs ${latencyClass(p.latencyMs)}`}>
            {formatLatency(p.latencyMs)}
          </span>
        ),
    },
    {
      key: "counts",
      header: "OK / Fail",
      align: "right",
      width: "w-[110px]",
      hideBelow: "lg",
      sortValue: (p) => p.successCount,
      cell: (p) => (
        <span className="tabular text-xs text-[var(--muted-foreground)]">
          {p.successCount} / {p.failCount}
        </span>
      ),
    },
    {
      key: "lastUsed",
      header: "Last used",
      hideBelow: "xl",
      sortValue: (p) => p.lastUsedAt ?? "",
      cell: (p) => (
        <span className="tabular text-xs text-[var(--muted-foreground)]">
          {p.lastUsedAt ? new Date(p.lastUsedAt).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[140px]",
      cell: (p) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Health check proxy"
            title="Health check"
            onClick={() => handleCheckSingle(p.id)}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={p.status === "active" ? "Disable proxy" : "Enable proxy"}
            title={p.status === "active" ? "Disable" : "Enable"}
            onClick={() => handleToggle(p.id, p.status)}
          >
            {p.status === "active" ? (
              <PowerOff className="h-4 w-4" />
            ) : (
              <Power className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="danger"
            size="icon"
            aria-label="Delete proxy"
            title="Delete"
            onClick={() => handleDelete(p.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="Proxy Pool"
        description="Manage HTTP/SOCKS5 proxies for upstream requests and auth"
        badge={
          <Badge variant="muted" className="tabular">
            {pool.activeCount}/{pool.count} active
          </Badge>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={handleCheckAll} loading={checking}>
              {!checking && <RefreshCw className="h-4 w-4" />}
              Check All
            </Button>
            {pool.count > 0 && (
              <Button variant="outline" size="sm" onClick={handleClearAll}>
                <Trash2 className="h-4 w-4" />
                Clear All
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading && pool.proxies.length === 0 ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <StatCard label="Proxies" value={pool.count} icon={Globe} tone="primary" />
            <StatCard label="Active" value={pool.activeCount} icon={Activity} tone="success" />
            <StatCard
              label="Errored"
              value={stats.errored}
              icon={ShieldAlert}
              tone={stats.errored > 0 ? "error" : "default"}
            />
            <StatCard
              label="Avg latency"
              value={stats.avgMs > 0 ? formatLatency(stats.avgMs) : "—"}
              icon={Timer}
              tone="info"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="h-4 w-4" />
              Add Proxies
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field
              label="Proxy list"
              hint="One per line. Supports http://, https:// and socks5:// with optional credentials."
              htmlFor="proxy-bulk"
            >
              <Textarea
                id="proxy-bulk"
                className="h-[120px] resize-none font-mono"
                placeholder={"http://user:pass@host:port\nsocks5://host:port\nhttp://host:port"}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
              />
            </Field>
            <Button onClick={handleBulkAdd} className="w-full">
              <Upload className="h-4 w-4" />
              Add to Pool
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4" />
              Scrape Proxies
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-[var(--muted-foreground)]">
              Pull fresh proxies from free public sources and add them straight to the pool.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Source" htmlFor="scrape-source">
                <Select
                  id="scrape-source"
                  value={scrapeSource}
                  onChange={(e) => setScrapeSource(e.target.value as typeof scrapeSource)}
                >
                  <option value="all">All sources</option>
                  <option value="proxyscrape">ProxyScrape</option>
                  <option value="geonode">Geonode</option>
                  <option value="proxifly">Proxifly</option>
                </Select>
              </Field>
              <Field label="Region" htmlFor="scrape-region">
                <Select
                  id="scrape-region"
                  value={scrapeCountry}
                  onChange={(e) => setScrapeCountry(e.target.value)}
                >
                  {countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Protocol" htmlFor="scrape-protocol">
                <Select
                  id="scrape-protocol"
                  value={scrapeProtocol}
                  onChange={(e) => setScrapeProtocol(e.target.value as typeof scrapeProtocol)}
                >
                  <option value="all">HTTP + SOCKS5</option>
                  <option value="http">HTTP</option>
                  <option value="socks5">SOCKS5</option>
                </Select>
              </Field>
              <Field label="Max count" htmlFor="scrape-limit">
                <Input
                  id="scrape-limit"
                  type="number"
                  min={1}
                  max={500}
                  className="tabular"
                  value={scrapeLimit}
                  onChange={(e) => setScrapeLimit(Number(e.target.value))}
                />
              </Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <input
                type="checkbox"
                checked={scrapeVerify}
                onChange={(e) => setScrapeVerify(e.target.checked)}
              />
              Health-check before adding (slower, but only keeps working proxies)
            </label>
            <Button onClick={handleScrape} loading={scraping} className="w-full">
              {!scraping && <Download className="h-4 w-4" />}
              {scraping ? "Scraping..." : "Scrape & Add"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <DataTable
        columns={columns}
        rows={pool.proxies}
        rowKey={(p) => p.id}
        loading={loading && pool.proxies.length === 0}
        pageSize={25}
        empty={
          <EmptyState
            compact
            icon={Globe}
            title="No proxies in pool"
            description="Add or scrape proxies above to enable IP rotation."
          />
        }
      />
    </PageShell>
  );
}
