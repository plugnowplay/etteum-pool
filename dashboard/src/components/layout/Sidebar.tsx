import { NavLink, useLocation } from "react-router-dom";
import { useEffect } from "react";
import {
  LogOut,
  X,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useWsStatus } from "@/hooks/useWebSocket";
import { navSections } from "@/lib/nav";

interface SidebarProps {
  onLogout?: () => void;
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

/** Shared row styling for nav links and the footer action buttons. */
function rowClass(collapsed: boolean, active = false, danger = false) {
  return cn(
    // Retro terminal menu rows: square, uppercase mono, left phosphor bar when
    // active (see the ▍ marker rendered by the caller).
    "group relative flex items-center gap-3 w-full border-l-2",
    "font-mono text-xs uppercase tracking-[0.1em]",
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
    collapsed ? "px-2 py-2 justify-center" : "px-3 py-2",
    active
      ? "border-l-[var(--primary)] bg-[var(--primary)]/12 text-[var(--primary)] retro-glow"
      : danger
        ? "border-l-transparent text-[var(--muted-foreground)] hover:border-l-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
        : "border-l-transparent text-[var(--muted-foreground)] hover:border-l-[var(--primary)]/60 hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
  );
}

/** Tooltip shown on hover when the sidebar is collapsed to icons only. */
function CollapsedTip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute left-full z-50 ml-2 whitespace-nowrap rounded-md",
        "border border-[var(--border)] bg-[var(--popover)] px-2 py-1 text-xs text-[var(--popover-foreground)]",
        "opacity-0 shadow-[var(--es-3)] transition-opacity duration-[var(--dur-fast)]",
        "group-hover:opacity-100"
      )}
    >
      {label}
    </span>
  );
}

/**
 * Opens the ⌘K palette by replaying the shortcut it already listens for. This
 * avoids threading extra state through Layout just to toggle a dialog.
 */
function openCommandPalette() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
  );
}

export default function Sidebar({
  onLogout,
  open,
  onClose,
  collapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const wsStatus = useWsStatus();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    onClose?.();
  }, [location.pathname]);

  const wsMeta =
    wsStatus === "open"
      ? { color: "var(--success)", label: "Live" }
      : wsStatus === "connecting"
        ? { color: "var(--warning)", label: "Connecting" }
        : { color: "var(--error)", label: "Offline" };

  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        "fixed left-0 top-0 z-50 flex h-screen flex-col border-r border-[var(--sidebar-border)]",
        "bg-[var(--sidebar-bg)] transition-[width,transform] duration-[var(--dur-base)] ease-[var(--ease-out)]",
        collapsed ? "w-[64px]" : "w-[240px]",
        open ? "translate-x-0 shadow-[var(--es-4)] md:shadow-none" : "-translate-x-full md:translate-x-0"
      )}
    >
      {/* Brand + connection status */}
      <div
        className={cn(
          "relative border-b border-[var(--sidebar-border)] p-4",
          collapsed ? "flex items-center justify-center" : "flex items-center justify-between"
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/etteum.svg" alt="" className="h-8 w-8 shrink-0" />
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-tight text-[var(--foreground)]">
                Etteum
              </h1>
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: wsMeta.color, boxShadow: `0 0 6px ${wsMeta.color}` }}
                />
                {wsMeta.label}
              </span>
            </div>
          )}
        </div>

        {onClose && !collapsed && (
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="focus-ring rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Collapse handle — rides the right edge of the sidebar */}
        <button
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "focus-ring absolute -right-3 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center md:flex",
            "z-10 rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]",
            "shadow-[var(--es-2)] transition-colors duration-[var(--dur-fast)]",
            "hover:border-[var(--primary)]/50 hover:text-[var(--foreground)]"
          )}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      </div>

      {/* Command palette launcher — mirrors the ⌘K hotkey for discoverability */}
      <div className={cn("pt-3", collapsed ? "px-2" : "px-3")}>
        <button
          onClick={openCommandPalette}
          aria-label="Open command palette"
          className={cn(
            "focus-ring group relative flex w-full items-center gap-2 rounded-lg border border-[var(--border)]",
            "bg-[var(--card)] text-sm text-[var(--muted-foreground)]",
            "transition-colors duration-[var(--dur-fast)] hover:border-[var(--primary)]/40 hover:text-[var(--foreground)]",
            collapsed ? "justify-center px-2 py-2" : "px-2.5 py-2"
          )}
        >
          <Search className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Search…</span>
              <kbd className="rounded border border-[var(--border)] bg-[var(--secondary)] px-1.5 py-0.5 text-[10px] font-medium">
                ⌘K
              </kbd>
            </>
          )}
          {collapsed && <CollapsedTip label="Search (⌘K)" />}
        </button>
      </div>

      {/* Sections */}
      <nav className={cn("flex-1 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}>
        {navSections.map((section) => (
          <div key={section.title} className="mb-5 last:mb-0">
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-[var(--sidebar-border)]" />
            ) : (
              <h2 className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]/70">
                {section.title}
              </h2>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className={({ isActive }) => rowClass(collapsed, isActive)}
                  >
                    {({ isActive }) => (
                      <>
                        {/* Active rail — reads at a glance even when collapsed */}
                        {isActive && (
                          <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-[var(--primary)]" />
                        )}
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                        {collapsed && <CollapsedTip label={item.label} />}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer actions */}
      <div
        className={cn(
          "space-y-0.5 border-t border-[var(--sidebar-border)] p-3",
          collapsed && "px-2"
        )}
      >
        <NavLink
          to="/change-password"
          className={({ isActive }) => rowClass(collapsed, isActive)}
        >
          <KeyRound className="h-4 w-4 shrink-0" />
          {!collapsed && "Change Password"}
          {collapsed && <CollapsedTip label="Change Password" />}
        </NavLink>

        <button
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className={rowClass(collapsed)}
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4 shrink-0" />
          ) : (
            <Moon className="h-4 w-4 shrink-0" />
          )}
          {!collapsed && (theme === "dark" ? "Light Mode" : "Dark Mode")}
          {collapsed && <CollapsedTip label={theme === "dark" ? "Light Mode" : "Dark Mode"} />}
        </button>

        {onLogout && (
          <button onClick={onLogout} aria-label="Log out" className={rowClass(collapsed, false, true)}>
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && "Logout"}
            {collapsed && <CollapsedTip label="Logout" />}
          </button>
        )}
      </div>
    </aside>
  );
}
