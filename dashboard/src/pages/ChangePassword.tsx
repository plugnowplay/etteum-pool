import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Eye, EyeOff, Lock } from "lucide-react";
import { API_BASE } from "@/lib/api";

export default function ChangePassword() {
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  // Which row the current validation error belongs to, so <Field error> lands
  // on the offending input instead of a generic banner.
  const errField =
    error === "Fill in all fields"
      ? !currentPass.trim()
        ? "current"
        : "new"
      : error === "New password must be at least 6 characters"
        ? "new"
        : error === "New passwords do not match"
          ? "confirm"
          : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!currentPass.trim() || !newPass.trim()) {
      setError("Fill in all fields");
      return;
    }
    if (newPass.length < 6) {
      setError("New password must be at least 6 characters");
      return;
    }
    if (newPass !== confirmPass) {
      setError("New passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localStorage.getItem("api_key") || ""}`,
        },
        body: JSON.stringify({ currentPassword: currentPass, newPassword: newPass }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to change password");
      } else {
        toast.success("Password changed successfully. Use the new password on next login.");
        setCurrentPass("");
        setNewPass("");
        setConfirmPass("");
      }
    } catch {
      toast.error("Cannot connect to server");
    }
    setLoading(false);
  }

  return (
    <div className="mx-auto max-w-md">
      <Card className="animate-scale-in shadow-[var(--es-3)]">
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary)]/10">
              <Lock className="h-4 w-4 text-[var(--primary)]" />
            </span>
            <CardTitle className="text-base">Change Password</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Current password"
              required
              htmlFor="cp-current"
              error={errField === "current" ? error : undefined}
            >
              <div className="relative">
                <Input
                  id="cp-current"
                  name="current-password"
                  type={showCur ? "text" : "password"}
                  icon={Lock}
                  autoComplete="current-password"
                  value={currentPass}
                  onChange={(e) => setCurrentPass(e.target.value)}
                  placeholder="Current password"
                  className="pr-10"
                  invalid={errField === "current"}
                />
                <button
                  type="button"
                  aria-label={showCur ? "Hide current password" : "Show current password"}
                  onClick={() => setShowCur(!showCur)}
                  className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  {showCur ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>

            <Field
              label="New password"
              required
              htmlFor="cp-new"
              hint={<>At least <span className="tabular">6</span> characters.</>}
              error={errField === "new" ? error : undefined}
            >
              <div className="relative">
                <Input
                  id="cp-new"
                  name="new-password"
                  type={showNew ? "text" : "password"}
                  icon={Lock}
                  autoComplete="new-password"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  placeholder="New password"
                  className="pr-10"
                  invalid={errField === "new"}
                />
                <button
                  type="button"
                  aria-label={showNew ? "Hide new password" : "Show new password"}
                  onClick={() => setShowNew(!showNew)}
                  className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>

            <Field
              label="Confirm new password"
              required
              htmlFor="cp-confirm"
              error={errField === "confirm" ? error : undefined}
            >
              <Input
                id="cp-confirm"
                name="confirm-password"
                type={showNew ? "text" : "password"}
                icon={Lock}
                autoComplete="new-password"
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
                placeholder="Confirm new password"
                invalid={errField === "confirm"}
              />
            </Field>

            <Button type="submit" className="w-full" loading={loading}>
              {loading ? "Saving…" : "Change Password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
