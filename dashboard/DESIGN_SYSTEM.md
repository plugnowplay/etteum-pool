# Etteum Dashboard — Design System (v2)

Reference for all page redesigns. Read this before touching any page.

## Tokens (src/index.css)

Colors: `var(--background|foreground|card|primary|secondary|muted|border|ring)`,
semantic `var(--success|warning|error|info|destructive)` + `-foreground` pairs.
Never hardcode hex. Never use raw Tailwind palette (`bg-gray-800`, `text-blue-500`).

New in v2:
- Elevation: `shadow-[var(--es-1)]` rest, `--es-2` hover, `--es-3` float/popover, `--es-4` overlay.
- Surfaces: `bg-[var(--surface-2)]` (table headers, footers, inset panels),
  `bg-[var(--surface-inset)]` (code/pre blocks).
- Motion: `duration-[var(--dur-fast|dur-base|dur-slow)]`, `ease-[var(--ease-out)]`.
- Animations: `animate-fade-in`, `animate-slide-up`, `animate-slide-in-right`, `animate-scale-in`.
- Utility classes: `.tabular` (tabular-nums — every number column/metric),
  `.focus-ring` (keyboard halo on custom buttons), `.skeleton` (shimmer).
- `prefers-reduced-motion` is handled globally — no per-component guards needed.

## Shared components

Import from `@/components/ui/...`.

```tsx
// page-header.tsx
<PageShell>                                   // animate-fade-in + space-y-6
  <PageHeader title description badge actions />
  <SectionHeader title description actions />  // in-page section heading
</PageShell>

// data-table.tsx  — sorting, pagination, responsive hiding, loading, empty
const columns: Column<Row>[] = [{
  key: "name", header: "Name", cell: (r) => <span/>,
  hideBelow: "md" | "lg" | "xl",   // progressive disclosure
  align: "right",                   // numbers
  sortValue: (r) => r.name,         // enables click-to-sort
  width: "w-24",
}];
<DataTable columns rows rowKey loading onRowClick activeKey pageSize={25} empty={<EmptyState/>} />

// stat-card.tsx
<StatCard label value hint icon={Activity} tone="primary|success|warning|error|info" delta={12.4} />
<Metric label value tone />          // compact, for drawers

// drawer.tsx  — Escape, backdrop, scroll-lock, focus handled
<Drawer open onClose title subtitle meta={<Badge/>} footer width="sm|md|lg">
  <DrawerSection title actions>...</DrawerSection>
  <KeyValue label value mono />
</Drawer>

// input.tsx
<SearchInput value onValueChange placeholder />   // magnifier + clear button
<Input icon={Mail} invalid />
<Field label hint error required htmlFor>...</Field>

// empty-state.tsx
<EmptyState icon={Inbox} title description action compact />

// skeleton.tsx
<Skeleton className="h-4 w-24" /> <SkeletonRows rows cols /> <SkeletonCard />

// toast.tsx — provider already mounted in main.tsx
const toast = useToast();
toast.success("Saved"); toast.error(msg); toast.warning(msg); toast.info(msg);
```

Primitives upgraded: `Button` (+`loading`, +`danger` variant, active:scale),
`Badge` (+`dot`, +`muted`), `Card` (+`CardInteractive`), `Select` (custom chevron),
`Textarea` (+`autoResize`, +`invalid`).

## Rules

1. Every page: `<PageShell>` + `<PageHeader>`. No bare `<h1 className="text-2xl">`.
2. Every table: `<DataTable>`. Delete hand-rolled `<table>` + `<thead>` markup.
3. Every slide-over: `<Drawer>`. Delete `fixed inset-0 flex justify-end` overlays.
4. Every inline `message`/`error` state string: `useToast()` instead.
5. Every "no data" string: `<EmptyState>`.
6. Every number (tokens, credits, latency, counts, IDs): add `.tabular`.
7. Every loading state: skeleton, not a "Loading..." string.
8. Icon-only buttons need `aria-label`. Sortable headers get `aria-sort` (DataTable does it).
9. Touch targets ≥44px on mobile — `Button` handles it; custom buttons need `min-h-[44px] md:min-h-0`.
10. Keep all existing behavior, API calls, and business logic identical. This is a
    presentation-layer refactor only.

## Verify

`cd dashboard && ~/.bun/bin/bun run build` — must exit 0 with no TS errors.
