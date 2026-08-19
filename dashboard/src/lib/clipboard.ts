/**
 * Clipboard helper with fallback for insecure contexts.
 *
 * navigator.clipboard is only available in secure contexts (https or
 * localhost). The dashboard is often opened over plain http on a LAN/VPS
 * IP, where navigator.clipboard is undefined and every copy button dies
 * (silently, or as an unhandled rejection). Fall back to the legacy
 * document.execCommand("copy") path with a temporary textarea.
 */

export async function copyText(text: string): Promise<boolean> {
  // Modern path — secure contexts only.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / not focused — fall through to legacy path.
  }

  // Legacy fallback — works in insecure contexts in all major browsers.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    const sel = document.getSelection();
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (savedRange && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    return ok;
  } catch {
    return false;
  }
}
