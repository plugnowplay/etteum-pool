import {
  LayoutDashboard,
  Users,
  Cpu,
  Key,
  Activity,
  BarChart3,
  Sliders,
  Bot,
  Globe,
  Sparkles,
  Filter,
  Plug,
  Layers,
  Share2,
  KeyRound,
} from "lucide-react";

export interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Extra words matched by the command palette but not shown in the sidebar. */
  keywords?: string[];
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * Single source of truth for navigation. Shared by the sidebar and the ⌘K
 * command palette so the two can never drift apart.
 *
 * Lives in its own module (not Sidebar.tsx) so Vite's Fast Refresh does not
 * complain about a file exporting both components and plain values.
 */
export const navSections: NavSection[] = [
  {
    title: "Accounts",
    items: [
      { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard, keywords: ["home", "overview", "stats"] },
      { label: "Accounts", path: "/accounts", icon: Users, keywords: ["pool", "byok", "kiro", "codex", "grok"] },
      { label: "Models", path: "/models", icon: Cpu, keywords: ["context", "custom model", "output"] },
      { label: "Combos", path: "/combos", icon: Layers, keywords: ["bundle", "mix"] },
    ],
  },
  {
    title: "Tools",
    items: [
      { label: "Image Studio", path: "/image-studio", icon: Sparkles, keywords: ["generate", "picture", "art"] },
      { label: "Integration", path: "/integration", icon: Plug, keywords: ["client", "setup", "cli"] },
    ],
  },
  {
    title: "Proxy",
    items: [
      { label: "API Key", path: "/api-key", icon: Key, keywords: ["token", "auth", "bearer"] },
      { label: "Share", path: "/share", icon: Share2, keywords: ["public", "link"] },
      { label: "Proxy Pool", path: "/proxy-pool", icon: Globe, keywords: ["rotation", "ip", "socks", "http"] },
      { label: "Filter Rules", path: "/filter-rules", icon: Filter, keywords: ["block", "allow", "rtk"] },
      { label: "Proxy Settings", path: "/settings", icon: Sliders, keywords: ["config", "load balance", "provider"] },
    ],
  },
  {
    title: "Logs & Analytics",
    items: [
      { label: "Requests", path: "/requests", icon: Activity, keywords: ["log", "trace", "errors"] },
      { label: "Login Logs", path: "/bot-logs", icon: Bot, keywords: ["auth", "signup", "warmup"] },
      { label: "Usage", path: "/usage", icon: BarChart3, keywords: ["tokens", "credits", "spend", "chart"] },
    ],
  },
];

/** Routes reachable from the palette but intentionally hidden in the sidebar. */
export const hiddenNavItems: NavItem[] = [
  {
    label: "Change Password",
    path: "/change-password",
    icon: KeyRound,
    keywords: ["security", "credentials"],
  },
];

/** Flat list of every navigable destination. */
export const allNavItems: NavItem[] = [
  ...navSections.flatMap((section) => section.items),
  ...hiddenNavItems,
];
