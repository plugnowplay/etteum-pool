# Etteum Dashboard — Design System (v4 · Retro CRT Terminal)

Reference for all page redesigns. Read this before touching any page.

Green-phosphor terminal, matched 1:1 to the public Share page
(`src/pages/PublicShare.tsx`) so the whole product reads as one machine.
Closest uipro style: **Cyberpunk UI / Retro-Futurism** — terminal aesthetic,
scanlines, monospace, phosphor glow.

**The four rules of this style:**
1. **Square** — no radius, anywhere.
2. **Hairline** — 1px borders, never thick.
3. **Glow, not shadow** — phosphor bloom replaces every drop shadow.
4. **Monospace + uppercase** — labels are wide-tracked and capitalised.

## Tokens (src/index.css)

Colors: `var(--background|foreground|card|primary|secondary|muted|border|ring)`,
semantic `var(--success|warning|error|info|destructive)` + `-foreground` pairs.
Never hardcode hex. Never use raw Tailwind palette (`bg-gray-800`, `text-blue-500`).

| Role | Dark (CRT) | Light (paper) |
|------|-----------|---------------|
| Primary | `#9dff70` phosphor | `#8a5a12` amber |
| Accent | `#baff9e` bright | `#7a3c0a` umber |
| Background | `#050a03` | `#f4ecd8` |
| Card | `#0a1206` | `#fbf6e9` |
| Warning / Error | `#ffd75f` / `#ff5f56` | `#8a5a12` / `#a32b20` |

Dark = green-on-black CRT (the canonical look, matches Share page exactly).
Light = amber dot-matrix printout — a green-on-white terminal is unreadable,
so light mode becomes the other authentic retro surface. Same era, real contrast.

### Geometry & glow (v4)
- `--radius: 0px`. Terminals are square.
- **Global override:** `[class*="rounded"] { border-radius: 0 !important }`.
  Tailwind's `rounded-*` use fixed rem values, *not* our token — squaring them
  centrally is what removes every stray pill across ~30 pages. Anything that
  genuinely needs a circle opts back in with `.is-round`.
- Borders are **1px** everywhere. Nav uses `border-l-2` for the active marker.
- Elevation = phosphor bloom, not distance: `--es-1` hairline ring, `--es-2`
  card/hover, `--es-3` float, `--es-4` overlay. On light mode these become
  crisp 1px rules (paper doesn't glow).
- `--text-glow` powers `.retro-glow`; it is `none` in light mode.
- Surfaces: `bg-[var(--surface-2)]` (table headers, footers), `bg-[var(--surface-inset)]`
  (code blocks, input wells).
- Motion: `duration-[var(--dur-fast|dur-base|dur-slow)]`, `ease-[var(--ease-out)]`.
- Animations: `animate-fade-in`, `animate-slide-up`, `animate-slide-in-right`,
  `animate-scale-in`, `animate-blink`, `animate-flicker`.
- Utility classes: `.retro-glow` (phosphor text bloom), `.retro-blink` (block
  cursor), `.tabular` (tabular-nums — every number), `.focus-ring`, `.skeleton`.
- Scanline + vignette overlay lives on `body::before/::after` — it therefore
  covers login, `/s`, and the app shell alike. Never add it per-page.
- `prefers-reduced-motion` is handled globally, including the blink and any
  hover/press transforms — no per-component guards needed.

### Typography
- **JetBrains Mono everywhere** — body, headings, numbers.
- `h1..h3` / `.font-display` are auto uppercase, `tracking-[0.12em]`, glowing.
- Numbers keep `.tabular` for aligned columns.

### Interaction idiom
Buttons and badges **invert on hover** — the fill floods with phosphor, exactly
like the `[CP]` / `[OK!]` buttons on the Share page. Nothing lifts or scales;
a terminal has no z-axis. Status badges stay *outlined* (colour signals state)
so table rows never turn into blocks of solid colour.

### Density (v4 — layout, not just skin)
A terminal is **dense**. The data is the interface; chrome gets out of the way.

| Element | Rule |
|---|---|
| `PageShell` | `space-y-3` (was `space-y-6`) |
| `PageHeader` | one prompt line: `>` marker + `text-base`, description `text-xs` |
| `main` padding | `p-3 md:p-4` (was `p-4 md:p-6`) |
| `StatCard` | **single row**, left rule only, ~28px tall |
| `DataTable` rows | `px-3 py-1.5 text-xs` |

Measured on `/requests` at 900px tall: the table used to start at **867px**
(below the fold — the log was invisible on load). It now starts at **~160px**
with 16–22 rows visible. If you add a page, keep the primary table above the fold.

> `StatCard` is deliberately a one-line gauge, not a tile. Six stacked tiles
> cost ~230px of vertical space and pushed the actual content off-screen.

### No boxes — rules instead (v4)
Full borders on every panel made pages read as **boxes nested in boxes**
(Settings had 3 levels deep). A terminal separates sections with a *rule*, the
way `── TITLE ────` does on the Share page.

| Use | Don't |
|---|---|
| `<Card>` = `border-t` + `pt-3`, transparent | Full frame + `bg-card` + shadow |
| `.panel` (left rule) for callouts/info blocks | `border border-border bg-surface-2 p-4` |
| `StatCard` = `border-l-2`, transparent | Bordered tile with filled bg |
| `DataTable` = header rule + row dividers | Outer frame around the table |
| Section heading = `border-t` + `pt-3` + small caps label | Boxed banner with a 40px icon |

**A full frame is only for something you can click** — `CardInteractive`,
provider tiles, menu items. It signals "one hit target", not decoration.
Audited: 0 nested boxes on every page; decorative frames only remain where they
group form controls (toolbars, selects).

`Card` internals have **no horizontal padding** — without side borders, content
should align to the page grid rather than sit inset from an invisible edge.

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

Primitives upgraded: `Button` (+`loading`, +`danger` variant, +`cta` variant, invert-on-hover),
`Badge` (+`dot`, +`muted`), `Card` (+`CardInteractive`), `Select` (custom chevron),
`Textarea` (+`autoResize`, +`invalid`).

`Button` variants: `default` (solid phosphor) · `cta` (outlined accent, floods on
hover — the one loudest action per page) · `outline` · `secondary` · `ghost` ·
`link` · `destructive` · `danger` (in-row delete). All square, uppercase, mono.

## Rules

1. Every page: `<PageShell>` + `<PageHeader>`. No bare `<h1 className="text-2xl">`.
2. Every table: `<DataTable>`. Delete hand-rolled `<table>` + `<thead>` markup.
3. Every slide-over: `<Drawer>`. Delete `fixed inset-0 flex justify-end` overlays.
4. Every inline `message`/`error` state string: `useToast()` instead.
5. Every "no data" string: `<EmptyState>`.
6. Every number (tokens, credits, latency, counts, IDs): add `.tabular`.
7. Every loading state: skeleton, not a "Loading..." string.
8. At most **one** `cta` button per view — it loses meaning if repeated.
9. Never add `rounded-*` expecting it to work; it's globally squared. Use
   `.is-round` if you truly need a circle (avatars, status dots).
10. Never add a drop shadow. Reach for `--es-*` (glow) or a border instead.
11. Never wrap a section in a full border. Use `border-t` (section) or `.panel`
    (callout). Full frames are reserved for clickable tiles.
8. Icon-only buttons need `aria-label`. Sortable headers get `aria-sort` (DataTable does it).
9. Touch targets ≥44px on mobile — `Button` handles it; custom buttons need `min-h-[44px] md:min-h-0`.
10. Keep all existing behavior, API calls, and business logic identical. This is a
    presentation-layer refactor only.

## Verify

`cd dashboard && ~/.bun/bin/bun run build` — must exit 0 with no TS errors.
