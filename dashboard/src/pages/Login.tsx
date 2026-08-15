import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
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
  const toast = useToast();

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
        toast.error(data.error || "Invalid username or password");
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.success && data.apiKey) {
        localStorage.setItem("api_key", data.apiKey);
        onLogin(data.apiKey);
      } else {
        toast.error("Login failed: no API key returned");
      }
    } catch {
      toast.error("Cannot connect to server");
    }
    setLoading(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] p-4">
      <Card className="animate-scale-in w-full max-w-sm shadow-[var(--es-3)]">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary)]/10">
            <Lock className="h-6 w-6 text-[var(--primary)]" />
          </div>
          <CardTitle className="text-lg">Etteum</CardTitle>
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
            Sign in to access the dashboard
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Username"
              required
              htmlFor="login-username"
              error={error && !username.trim() ? error : undefined}
            >
              <Input
                id="login-username"
                name="username"
                type="text"
                icon={User}
                autoComplete="username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setError(null);
                }}
                placeholder="Username"
                invalid={Boolean(error && !username.trim())}
                autoFocus
              />
            </Field>

            <Field
              label="Password"
              required
              htmlFor="login-password"
              error={error && username.trim() && !password.trim() ? error : undefined}
            >
              <div className="relative">
                <Input
                  id="login-password"
                  name="password"
                  type={showPass ? "text" : "password"}
                  icon={Lock}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  placeholder="Password"
                  className="pr-10"
                  invalid={Boolean(error && username.trim() && !password.trim())}
                />
                <button
                  type="button"
                  aria-label={showPass ? "Hide password" : "Show password"}
                  onClick={() => setShowPass(!showPass)}
                  className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>

            <Button type="submit" className="w-full" loading={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
