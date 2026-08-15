import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { Copy, Eye, EyeOff, RefreshCw, Check, Save, ShieldCheck } from "lucide-react";
import { fetchApiKey, regenerateApiKey, setApiKey, testApiKey } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

export default function ApiKey() {
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("api_key") || "pool-proxy-secret-key");
  const [source, setSource] = useState("browser");
  const [showKey, setShowKey] = useState(false);
  const { message: copied, setMessage: setCopiedTimed } = useTimedMessage<boolean>(null, 2000);
  const [valid, setValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"load" | "test" | "regen" | "save" | null>(null);
  const toast = useToast();

  function notify(text: string) {
    toast.success(text);
  }

  function fail(err: unknown) {
    toast.error(err instanceof Error ? err.message : String(err));
  }

  function saveToBrowser(key = apiKey) {
    localStorage.setItem("api_key", key);
    setApiKeyState(key);
  }

  async function loadKey() {
    setBusy("load");
    try {
      const res = await fetchApiKey() as { key: string; source: string };
      setApiKeyState(res.key);
      setSource(res.source);
      saveToBrowser(res.key);
      setValid(true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    loadKey();
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(apiKey);
    setCopiedTimed(true);
  };

  async function handleSave() {
    setBusy("save");
    try {
      const res = await setApiKey(apiKey) as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("API key saved to backend and browser. It can now be used for proxy requests.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleRegenerate() {
    if (!confirm("Regenerate API key? Existing generated key will stop working.")) return;
    setBusy("regen");
    try {
      const res = await regenerateApiKey() as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("New API key generated, saved, and activated.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    try {
      const res = await testApiKey(apiKey) as { valid: boolean };
      setValid(res.valid);
      notify(res.valid ? "API key is valid." : "API key is invalid.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="API Key"
        description="Generate and activate proxy API keys."
        badge={
          <Badge variant={valid === true ? "success" : valid === false ? "error" : "muted"} dot>
            {valid === true ? "valid" : valid === false ? "invalid" : "not tested"}
          </Badge>
        }
      />

      <Card className="max-w-3xl border-[var(--border)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> Active API Key
          </CardTitle>
          <CardDescription>
            Source: <span className="font-mono">{source}</span>. The env fallback key also remains accepted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Key" htmlFor="api-key-input" hint="Stored in this browser and pushed to the backend on save.">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="api-key-input"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKeyState(e.target.value);
                    setValid(null);
                  }}
                  className="pr-10 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 rounded text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button variant="outline" size="icon" onClick={handleCopy} aria-label="Copy API key" title="Copy">
                {copied ? <Check className="h-4 w-4 text-[var(--success)]" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </Field>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={loadKey} loading={busy === "load"}>
              Load Active
            </Button>
            <Button variant="outline" size="sm" onClick={handleTest} loading={busy === "test"}>
              Test
            </Button>
            <Button variant="outline" size="sm" onClick={handleRegenerate} loading={busy === "regen"}>
              {busy !== "regen" && <RefreshCw className="h-4 w-4" />} Generate
            </Button>
            <Button size="sm" onClick={handleSave} loading={busy === "save"}>
              {busy !== "save" && <Save className="h-4 w-4" />} Save &amp; Activate
            </Button>
          </div>

          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <h4 className="mb-2 text-sm font-medium text-[var(--foreground)]">Usage Example</h4>
            <pre className="overflow-x-auto rounded-md bg-[var(--surface-inset)] p-3 text-xs leading-relaxed text-[var(--muted-foreground)]">
{`curl http://localhost:1930/v1/chat/completions \\
  -H "Authorization: Bearer *** ? apiKey : *** \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
