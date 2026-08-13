import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, Lock } from "lucide-react";
import { API_BASE } from "@/lib/api";

export default function ChangePassword() {
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

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
        setError(data.error || "Failed to change password");
      } else {
        setSuccess("Password changed successfully. Use the new password on next login.");
        setCurrentPass("");
        setNewPass("");
        setConfirmPass("");
      }
    } catch {
      setError("Cannot connect to server");
    }
    setLoading(false);
  }

  return (
    <div className="max-w-md mx-auto">
      <Card className="border-[var(--border)]">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-[var(--primary)]" />
            <CardTitle className="text-lg">Change Password</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
              <Input
                type={showCur ? "text" : "password"}
                value={currentPass}
                onChange={(e) => setCurrentPass(e.target.value)}
                placeholder="Current password"
                className="pl-10 pr-10 text-sm"
              />
              <button type="button" onClick={() => setShowCur(!showCur)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                {showCur ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
              <Input
                type={showNew ? "text" : "password"}
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                placeholder="New password"
                className="pl-10 pr-10 text-sm"
              />
              <button type="button" onClick={() => setShowNew(!showNew)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
              <Input
                type={showNew ? "text" : "password"}
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
                placeholder="Confirm new password"
                className="pl-10 text-sm"
              />
            </div>

            {error && (
              <div className="rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">{error}</div>
            )}
            {success && (
              <div className="rounded-md bg-[var(--success)]/10 p-3 text-sm text-[var(--success)]">{success}</div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Saving..." : "Change Password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
