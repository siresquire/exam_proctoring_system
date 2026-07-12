"use client";

import * as React from "react";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";

interface TempPasswordRevealProps {
  /** The one-time temp password to reveal. Never persisted anywhere — this component only ever holds it in memory/state. */
  password: string;
  /** Short lead-in, e.g. "New account created" or "Password reset". */
  title: string;
  /** Extra context sentence shown under the password, e.g. who must change it. */
  description?: string;
  className?: string;
}

/**
 * Single source of truth for the "reveal a temp password exactly once" UI —
 * used by CreateUserDialog, AddStudentDialog, and the Users & roles table's
 * Reset-password action. Renders as a PERSISTENT panel inside whatever
 * dialog/step is already open — never a SweetAlert2 popup — because
 * SweetAlert2 renders via its own portal at a much higher stacking context
 * (z-index ~1060) than shadcn/Radix `DialogContent` (z-50), so a
 * `notify.success(...)` fired right after this panel mounts would render
 * ON TOP of it and completely obscure the very thing it just told the admin
 * to "copy below" (the bug this component was extracted to fix — see
 * create-user-dialog.tsx's history). Callers that also want a notification
 * MUST use `notify.toast` (small, corner-positioned, non-blocking) rather
 * than `notify.success`/`notify.info` (large, centered, modal) whenever this
 * panel is on screen at the same time.
 *
 * Accessibility: the panel is a `role="status"` live region so screen
 * readers announce it as it appears, and focus moves to it on mount/update
 * (`tabIndex={-1}` + an effect keyed on `password`) so keyboard and screen-
 * reader users land directly on the one thing they need to act on next,
 * instead of being left wherever focus was inside the just-submitted form.
 */
export function TempPasswordReveal({ password, title, description, className }: TempPasswordRevealProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    panelRef.current?.focus();
  }, [password]);

  async function handleCopy() {
    await navigator.clipboard.writeText(password);
    await notify.toast({ title: "Temp password copied" });
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="status"
      className={cn(
        "border-primary/40 bg-primary/5 space-y-2 rounded-md border-2 p-3 outline-none",
        className,
      )}
    >
      <p className="text-sm font-medium">
        {title}. This temp password is shown <strong>once</strong> — copy it now.
      </p>
      <div className="flex items-center gap-2">
        <code className="bg-muted flex-1 rounded px-2 py-1.5 font-mono text-sm break-all">{password}</code>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy} className="min-h-11">
          <Copy aria-hidden />
          Copy
        </Button>
      </div>
      {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
    </div>
  );
}
