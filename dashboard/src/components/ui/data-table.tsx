import * as React from "react";
import { ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

export interface Column<T> {
  /** Stable key — also used as the sort key. */
  key: string;
  header: React.ReactNode;
  /** Cell renderer. */
  cell: (row: T) => React.ReactNode;
  /** Hide below a breakpoint: "md" | "lg" | "xl". */
  hideBelow?: "sm" | "md" | "lg" | "xl";
  /** Right-align (numbers). */
  align?: "left" | "right" | "center";
  /** Enable click-to-sort using this accessor. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Fixed width utility class, e.g. "w-24". */
  width?: string;
  /** Mark as the primary column — always shown, bolder on mobile cards. */
  primary?: boolean;
}

const hideMap = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
} as const;

const alignMap = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
} as const;

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  /** Rendered when there are no rows and not loading. */
  empty?: React.ReactNode;
  /** Client-side pagination; omit to render every row. */
  pageSize?: number;
  /** Highlight the active row (e.g. open in a drawer). */
  activeKey?: string | number | null;
  className?: string;
  /** Sticky header — needs a scroll container with a max height. */
  stickyHeader?: boolean;
  /** Extra node rendered in the footer, left of the pager. */
  footerLeft?: React.ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  onRowClick,
  empty,
  pageSize,
  activeKey,
  className,
  stickyHeader = false,
  footerLeft,
}: DataTableProps<T>) {
  const [page, setPage] = React.useState(1);
  const [sort, setSort] = React.useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  // Reset to page 1 whenever the underlying row count changes (filter/search).
  React.useEffect(() => {
    setPage(1);
  }, [rows.length]);

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, sort, columns]);

  const totalPages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const safePage = Math.min(page, totalPages);
  const visible = pageSize
    ? sorted.slice((safePage - 1) * pageSize, safePage * pageSize)
    : sorted;

  function toggleSort(col: Column<T>) {
    if (!col.sortValue) return;
    setSort((s) =>
      s?.key === col.key
        ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: col.key, dir: "asc" }
    );
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-[var(--es-1)]",
        className
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className={cn(stickyHeader && "sticky top-0 z-10")}>
            <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
              {columns.map((col) => {
                const sortable = Boolean(col.sortValue);
                const active = sort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={
                      active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined
                    }
                    className={cn(
                      "px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]",
                      alignMap[col.align ?? "left"],
                      col.hideBelow && hideMap[col.hideBelow],
                      col.width,
                      sortable && "cursor-pointer select-none transition-colors hover:text-[var(--foreground)]"
                    )}
                    onClick={sortable ? () => toggleSort(col) : undefined}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        col.align === "right" && "flex-row-reverse"
                      )}
                    >
                      {col.header}
                      {sortable &&
                        (active ? (
                          sort!.dir === "asc" ? (
                            <ArrowUp className="h-3 w-3 text-[var(--primary)]" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-[var(--primary)]" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        ))}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>

          {!loading && (
            <tbody>
              {visible.map((row) => {
                const key = rowKey(row);
                const isActive = activeKey != null && key === activeKey;
                return (
                  <tr
                    key={key}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      "border-b border-[var(--border)] transition-colors duration-[var(--dur-fast)] last:border-0",
                      onRowClick && "cursor-pointer",
                      isActive
                        ? "bg-[var(--primary)]/8"
                        : onRowClick && "hover:bg-[var(--secondary)]/60"
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          "px-4 py-3 align-middle text-sm text-[var(--foreground)]",
                          alignMap[col.align ?? "left"],
                          col.hideBelow && hideMap[col.hideBelow]
                        )}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>

      {loading && <SkeletonRows rows={6} cols={Math.min(columns.length, 5)} />}

      {!loading && visible.length === 0 && (
        <>{empty ?? <EmptyState compact title="Nothing here yet" />}</>
      )}

      {(footerLeft || (pageSize && sorted.length > pageSize)) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
          <p className="tabular text-[11px] text-[var(--muted-foreground)]">
            {footerLeft ??
              `${(safePage - 1) * pageSize! + 1}–${Math.min(
                safePage * pageSize!,
                sorted.length
              )} of ${sorted.length}`}
          </p>
          {pageSize && sorted.length > pageSize && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous page"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
                className="h-7 w-7 min-h-0 min-w-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tabular px-1 text-[11px] text-[var(--muted-foreground)]">
                {safePage} / {totalPages}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next page"
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
                className="h-7 w-7 min-h-0 min-w-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
