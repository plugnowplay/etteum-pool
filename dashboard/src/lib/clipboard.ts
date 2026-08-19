/**
 * Clipboard helper with fallback for insecure contexts.
 *
 * navigator.clipboard is only available in secure contexts (https or
 * localhost). The dashboard is often opened over plain http on a LAN/VPS
 * IP, where navigator.clipboard is undefined and every copy button dies
 * (silently, or as an unhandled rejection). Fall back to the legacy
 * document.execCommand("copy") path with a temporary textarea.
 *
 * IMPORTANT: the textarea must be appended INSIDE the currently open
 * dialog (if any). Radix/shadcn dialogs run a focus trap — an element
 * appended to document.body cannot receive focus, so select() selects
 * nothing and execCommand("copy") copies an empty/stale selection.
 */

function findFocusableHost(): HTMLElement {
  // Any open dialog (Radix sets role=dialog) traps focus — append there.
  const dlg = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
  if (dlg) return dlg;
  // Popovers / sheets / drawers may use different roles.
  const pop = document.querySelector<HTMLElement>('[data-state="open"][role="dialog"], [data-radix-popper-content-wrapper]');
  if (pop) return pop;
  return document.body;
}

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
    const host = findFocusableHost();
    host.appendChild(ta);
    const sel = document.getSelection();
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    host.removeChild(ta);
    if (savedRange && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    return ok;
  } catch {
    return false;
  }
}
