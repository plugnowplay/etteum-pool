import * as React from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Moon, Sun, RefreshCw, LogOut, CornerDownLeft } from "lucide-react";
import { navSections, hiddenNavItems } from "@/lib/nav";
import { useTheme } from "@/hooks/useTheme";
import { useToast } from "@/components/ui/toast";

/**
 * ⌘K / Ctrl+K command palette.
 *
 * Navigation entries come from `@/lib/nav` so they always match the sidebar.
 * Actions cover the things you otherwise have to hunt for in the UI (theme,
 * cache refresh, logout).
 */
export function CommandPalette({ onLogout }: { onLogout?: () => void }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const qc = useQueryClient();
  const toast = useToast();

  // Global hotkey. `⌘K` on macOS, `Ctrl+K` elsewhere.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Close first, then run — keeps the transition from fighting the route change. */
  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    // Defer so the dialog unmount doesn't swallow focus from the new view.
    window.setTimeout(fn, 0);
  }, []);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      // cmdk renders its own Radix dialog; style the overlay + positioner here.
      className="fixed inset-0 z-[200]"
      overlayClassName="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm data-[state=open]:animate-fade-in"
      contentClassName={
        "fixed left-1/2 top-[15vh] z-[201] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 " +
        "overflow-hidden rounded-[var(--radius)] border border-[var(--border)] " +
        "bg-[var(--popover)] shadow-[var(--es-4)] data-[state=open]:animate-scale-in"
      }
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4">
        <Command.Input
          autoFocus
          placeholder="Search pages or run a command…"
          className="h-12 w-full bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
        />
        <kbd className="hidden shrink-0 rounded border border-[var(--border)] bg-[var(--secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)] sm:block">
          ESC
        </kbd>
      </div>

      <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-[var(--muted-foreground)]">
          No results found.
        </Command.Empty>

        {navSections.map((section) => (
          <Command.Group
            key={section.title}
            heading={section.title}
            className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--muted-foreground)]"
          >
            {section.items.map((item) => (
              <PaletteItem
                key={item.path}
                icon={item.icon}
                label={item.label}
                keywords={item.keywords}
                onSelect={() => run(() => navigate(item.path))}
              />
            ))}
          </Command.Group>
        ))}

        <Command.Group
          heading="Actions"
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--muted-foreground)]"
        >
          <PaletteItem
            icon={theme === "light" ? Moon : Sun}
            label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            keywords={["theme", "appearance", "dark", "light"]}
            onSelect={() => run(toggleTheme)}
          />
          <PaletteItem
            icon={RefreshCw}
            label="Refresh all data"
            keywords={["reload", "invalidate", "cache"]}
            onSelect={() =>
              run(() => {
                qc.invalidateQueries();
                toast.success("Refreshing all data");
              })
            }
          />
          {hiddenNavItems.map((item) => (
            <PaletteItem
              key={item.path}
              icon={item.icon}
              label={item.label}
              keywords={item.keywords}
              onSelect={() => run(() => navigate(item.path))}
            />
          ))}
          {onLogout && (
            <PaletteItem
              icon={LogOut}
              label="Log out"
              keywords={["sign out", "exit"]}
              destructive
              onSelect={() => run(onLogout)}
            />
          )}
        </Command.Group>
      </Command.List>

      <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-[11px] text-[var(--muted-foreground)]">
        <span className="flex items-center gap-1.5">
          <CornerDownLeft className="h-3 w-3" /> to select
        </span>
        <span>↑ ↓ to navigate</span>
      </div>
    </Command.Dialog>
  );
}

function PaletteItem({
  icon: Icon,
  label,
  keywords,
  onSelect,
  destructive = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  keywords?: string[];
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <Command.Item
      value={label}
      keywords={keywords}
      onSelect={onSelect}
      className={
        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm " +
        "text-[var(--foreground)] transition-colors duration-[var(--dur-fast)] " +
        "data-[selected=true]:bg-[var(--secondary)] " +
        (destructive ? "data-[selected=true]:text-[var(--error)]" : "")
      }
    >
      <Icon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
      <span className="truncate">{label}</span>
    </Command.Item>
  );
}
