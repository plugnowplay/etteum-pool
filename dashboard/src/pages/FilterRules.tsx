import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { useToast } from "@/components/ui/toast";
import { Filter, Plus, Trash2, Power, PowerOff, Pencil, X, CheckCircle2 } from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";

interface FilterRule {
  id: number;
  ruleId: string;
  pattern: string;
  replacement: string;
  isActive: boolean;
  isRegex: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string | null;
}

interface FilterListResponse {
  count: number;
  activeCount: number;
  rules: FilterRule[];
}

interface RuleFormState {
  id: number | null;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isActive: boolean;
}

const emptyForm: RuleFormState = { id: null, pattern: "", replacement: "", isRegex: true, isActive: true };

export default function FilterRules() {
  const [data, setData] = useState<FilterListResponse>({ count: 0, activeCount: 0, rules: [] });
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<RuleFormState | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const result = await fetchApi<FilterListResponse>("/api/filters");
      setData(result);
    } catch {
      setData({ count: 0, activeCount: 0, rules: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useWsEvent(["filter_rules_updated"], load);

  const handleToggle = async (rule: FilterRule) => {
    try {
      await fetchApi(`/api/filters/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      load();
    } catch (e: any) {
      toast.error(e.message || "Failed to toggle rule");
    }
  };

  const handleDelete = async (rule: FilterRule) => {
    if (!confirm(`Delete rule "${rule.ruleId}"?`)) return;
    try {
      await fetchApi(`/api/filters/${rule.id}`, { method: "DELETE" });
      toast.success("Rule deleted");
      load();
    } catch (e: any) {
      toast.error(e.message || "Failed to delete rule");
    }
  };

  const handleSave = async () => {
    if (!form) return;
    if (!form.pattern.trim()) {
      toast.warning("Pattern is required");
      return;
    }
    try {
      if (form.id == null) {
        await fetchApi("/api/filters", {
          method: "POST",
          body: JSON.stringify({
            pattern: form.pattern,
            replacement: form.replacement,
            isRegex: form.isRegex,
            isActive: form.isActive,
          }),
        });
        toast.success("Rule created");
      } else {
        await fetchApi(`/api/filters/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            pattern: form.pattern,
            replacement: form.replacement,
            isRegex: form.isRegex,
            isActive: form.isActive,
          }),
        });
        toast.success("Rule updated");
      }
      setForm(null);
      load();
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    }
  };

  const truncate = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const columns: Column<FilterRule>[] = [
    {
      key: "sortOrder",
      header: "#",
      width: "w-[56px]",
      sortValue: (r) => r.sortOrder,
      cell: (r) => (
        <span className="tabular text-xs text-[var(--muted-foreground)]">{r.sortOrder}</span>
      ),
    },
    {
      key: "ruleId",
      header: "Rule ID",
      hideBelow: "lg",
      width: "w-[160px]",
      sortValue: (r) => r.ruleId,
      cell: (r) => (
        <span className="tabular block truncate font-mono text-xs text-[var(--muted-foreground)]">
          {r.ruleId}
        </span>
      ),
    },
    {
      key: "pattern",
      header: "Pattern",
      primary: true,
      sortValue: (r) => r.pattern,
      cell: (r) => (
        <div className="min-w-0">
          <span
            className="block truncate font-mono text-sm text-[var(--foreground)]"
            title={r.pattern}
          >
            {truncate(r.pattern)}
          </span>
          {r.replacement && (
            <span
              className="mt-0.5 block truncate font-mono text-xs text-[var(--muted-foreground)]"
              title={r.replacement}
            >
              → {truncate(r.replacement, 30)}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      width: "w-[100px]",
      hideBelow: "md",
      sortValue: (r) => (r.isRegex ? "regex" : "string"),
      cell: (r) => (
        <Badge variant={r.isRegex ? "info" : "default"}>{r.isRegex ? "regex" : "string"}</Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[100px]",
      sortValue: (r) => (r.isActive ? 1 : 0),
      cell: (r) => (
        <Badge variant={r.isActive ? "success" : "muted"} dot>
          {r.isActive ? "active" : "off"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[140px]",
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={r.isActive ? "Disable rule" : "Enable rule"}
            title={r.isActive ? "Disable" : "Enable"}
            onClick={() => handleToggle(r)}
          >
            {r.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Edit rule"
            title="Edit"
            onClick={() =>
              setForm({
                id: r.id,
                pattern: r.pattern,
                replacement: r.replacement,
                isRegex: r.isRegex,
                isActive: r.isActive,
              })
            }
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="danger"
            size="icon"
            aria-label="Delete rule"
            title="Delete"
            onClick={() => handleDelete(r)}
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
        title="Filter Rules"
        description="Pre-request sanitizer rules to strip patterns that trigger upstream content moderation"
        badge={
          <Badge variant="muted" className="tabular">
            {data.activeCount}/{data.count} active
          </Badge>
        }
        actions={
          <Button size="sm" onClick={() => setForm({ ...emptyForm })}>
            <Plus className="h-4 w-4" />
            Add Rule
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Rules" value={data.count} icon={Filter} tone="primary" />
        <StatCard label="Active" value={data.activeCount} icon={CheckCircle2} tone="success" />
        <StatCard
          label="Regex"
          value={data.rules.filter((r) => r.isRegex).length}
          icon={Filter}
          tone="info"
        />
        <StatCard
          label="Disabled"
          value={data.rules.filter((r) => !r.isActive).length}
          icon={PowerOff}
          tone="warning"
        />
      </div>

      {form && (
        <Card className="animate-slide-up">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Filter className="h-4 w-4" />
              {form.id == null ? "New Rule" : "Edit Rule"}
            </CardTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close rule form"
              onClick={() => setForm(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field
              label="Pattern"
              required
              htmlFor="rule-pattern"
              hint={form.isRegex ? "JavaScript regex, case-insensitive." : "Matched as an exact string."}
            >
              <Textarea
                id="rule-pattern"
                className="h-[80px] resize-none font-mono"
                placeholder={form.isRegex ? "regex pattern (case-insensitive)" : "exact string to match"}
                value={form.pattern}
                onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              />
            </Field>
            <Field label="Replacement" htmlFor="rule-replacement">
              <Textarea
                id="rule-replacement"
                className="h-[60px] resize-none font-mono"
                placeholder="(empty to remove the matched text)"
                value={form.replacement}
                onChange={(e) => setForm({ ...form, replacement: e.target.value })}
              />
            </Field>
            <div className="flex items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isRegex}
                  onChange={(e) => setForm({ ...form, isRegex: e.target.checked })}
                />
                Regex
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSave}>Save</Button>
              <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={data.rules}
        rowKey={(r) => r.id}
        loading={loading && data.rules.length === 0}
        pageSize={25}
        empty={
          <EmptyState
            compact
            icon={Filter}
            title="No filter rules"
            description="Click Add Rule to create your first sanitizer pattern."
            action={
              <Button size="sm" onClick={() => setForm({ ...emptyForm })}>
                <Plus className="h-4 w-4" />
                Add Rule
              </Button>
            }
          />
        }
      />
    </PageShell>
  );
}
