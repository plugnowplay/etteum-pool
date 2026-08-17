import { lazy, Suspense, useState, useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import Layout from "./components/layout/Layout";
import Login from "./pages/Login";
import { Skeleton, SkeletonCard, SkeletonRows } from "./components/ui/skeleton";
import { isAuthenticated, validateApiKey, logout } from "./lib/api";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Accounts = lazy(() => import("./pages/Accounts"));
const AccountList = lazy(() => import("./pages/AccountList"));
const ByokAccountList = lazy(() => import("./pages/ByokAccountList"));
const Models = lazy(() => import("./pages/Models"));
const Combos = lazy(() => import("./pages/Combos"));
const ApiKey = lazy(() => import("./pages/ApiKey"));
const Share = lazy(() => import("./pages/Share"));
const Requests = lazy(() => import("./pages/Requests"));
const Usage = lazy(() => import("./pages/Usage"));
const Settings = lazy(() => import("./pages/Settings"));
const BotLogs = lazy(() => import("./pages/BotLogs"));
const VccPool = lazy(() => import("./pages/VccPool"));
const ProxyPool = lazy(() => import("./pages/ProxyPool"));
const ImageStudio = lazy(() => import("./pages/ImageStudio"));
const FilterRules = lazy(() => import("./pages/FilterRules"));
const Integration = lazy(() => import("./pages/Integration"));
const CodexOAuthCallback = lazy(() => import("./pages/CodexOAuthCallback"));
const ChangePassword = lazy(() => import("./pages/ChangePassword"));
const PublicShare = lazy(() => import("./pages/PublicShare"));

function RouteFallback() {
  return (
    <div className="animate-fade-in space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
        <SkeletonRows rows={6} cols={4} />
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    async function check() {
      if (!isAuthenticated()) {
        setAuthed(false);
        return;
      }
      const key = localStorage.getItem("api_key")!;
      const valid = await validateApiKey(key);
      if (!valid) {
        logout();
        setAuthed(false);
      } else {
        setAuthed(true);
      }
    }
    check();
  }, []);

  function handleLogin(_apiKey?: string) {
    setAuthed(true);
  }

  function handleLogout() {
    logout();
    setAuthed(false);
  }

  if (authed === null) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <img src="/etteum.svg" alt="" className="h-10 w-10 animate-pulse" />
        <Skeleton className="h-3 w-28" />
      </div>
    );
  }

  // Public unauthenticated share landing — must render regardless of auth.
  if (location.pathname === "/s" || location.pathname === "/s/") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PublicShare />
      </Suspense>
    );
  }

  if (!authed) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<Layout onLogout={handleLogout} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/byok/:prefix" element={<ByokAccountList />} />
          <Route path="/accounts/:provider" element={<AccountList />} />
          <Route path="/models" element={<Models />} />
          <Route path="/combos" element={<Combos />} />
          <Route path="/api-key" element={<ApiKey />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/bot-logs" element={<BotLogs />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/vcc-pool" element={<VccPool />} />
          <Route path="/proxy-pool" element={<ProxyPool />} />
          <Route path="/filter-rules" element={<FilterRules />} />
          <Route path="/integration" element={<Integration />} />
          <Route path="/image-studio" element={<ImageStudio />} />
          <Route path="/oauth/codex/callback" element={<CodexOAuthCallback />} />
          <Route path="/change-password" element={<ChangePassword />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
