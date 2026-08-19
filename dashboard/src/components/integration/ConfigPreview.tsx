import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";

interface ConfigPreviewProps {
  config: Record<string, unknown> | string;
  label?: string;
}

export function ConfigPreview({ config, label }: ConfigPreviewProps) {
  const [copied, setCopied] = useState(false);

  const content =
    typeof config === "string" ? config : JSON.stringify(config, null, 2);

  const handleCopy = async () => {
    const ok = await copyText(content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="group/config space-y-1.5">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">
            {label}
          </span>
          <button
            onClick={handleCopy}
            aria-label={copied ? "Copied to clipboard" : "Copy config"}
            className={cn(
              "focus-ring flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
              "transition-colors duration-[var(--dur-fast)]",
              copied
                ? "text-[var(--success)]"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            )}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <pre className="max-h-64 overflow-auto whitespace-pre rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--foreground)]">
        {content}
      </pre>
    </div>
  );
}
