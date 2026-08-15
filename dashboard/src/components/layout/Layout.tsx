import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutProps {
  onLogout?: () => void;
}

export default function Layout({ onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sidebar-collapsed", collapsed ? "true" : "false");
    } catch {}
  }, [collapsed]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {sidebarOpen && (
        <div
          className="animate-fade-in fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] md:hidden"
          onClick={() => setSidebarOpen(false)}
          role="presentation"
        />
      )}

      <Sidebar
        onLogout={onLogout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />

      {/* Mobile top bar — keeps the menu button off the content it overlaps */}
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-[var(--border)] px-4 md:hidden",
          "bg-[var(--background)]/85 backdrop-blur-md"
        )}
      >
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Open navigation"
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-[var(--es-1)] transition-colors hover:bg-[var(--secondary)]"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <img src="/etteum.svg" alt="" className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
            Etteum
          </span>
        </div>
      </header>

      <main
        className={cn(
          "h-screen overflow-y-auto p-4 pt-18 transition-[margin] duration-[var(--dur-base)] ease-[var(--ease-out)] md:p-6 md:pt-6",
          collapsed ? "md:ml-[64px]" : "md:ml-[240px]"
        )}
      >
        <div className="mx-auto max-w-[1600px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
