import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Lock, User } from "lucide-react";
import { API_BASE } from "@/lib/api";

interface LoginProps {
  onLogin: (apiKey: string) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("Enter username and password");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/auth/dashboard-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Invalid username or password");
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.success && data.apiKey) {
        localStorage.setItem("api_key", data.apiKey);
        onLogin(data.apiKey);
      } else {
        setError("Login failed: no API key returned");
      }
    } catch {
      setError("Cannot connect to server");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] p-4">
      <Card className="w-full max-w-sm border-[var(--border)]">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary)]/10">
            <Lock className="h-6 w-6 text-[var(--primary)]" />
          </div>
          <CardTitle className="text-xl">Etteum</CardTitle>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Sign in to access the dashboard
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
              <Input
                type="text"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setError(null); }}
                placeholder="Username"
                className="pl-10 text-sm"
                autoFocus
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
              <Input
                type={showPass ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder="Password"
                className="pl-10 pr-10 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowPass(!showPass)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {error && (
              <div className="rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
